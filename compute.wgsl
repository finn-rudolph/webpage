// Some facts about the data here:
//
//   *  All buffers for grid data are padded by 1 in x and y direction to handle
//      boundary conditions. When grid coordinates are passed around, they are 0-based.
//      We only add the + 1 when accessing data.
//
//   *  The current (or input) data is always in s0, u0 or p0. Whether the new data
//      is written to (u/s/p)0 or (u/s/p)1 depends on the shader.
//
//   *  Coordinate systems:
//       -  Normalized coordinates: [0, aspect_ratio] x [0, 1]
//       -  Grid coordinates: [0, Grid.res.x] x [0, Grid.res.y] In general they are not the same
//          for u and s, since u and s may have different resolutions.
//       -  Pixel coordinates: [0, canvas.width] x [0, canvas.height] The screen pixel coordinates.
//          aspect_ratio := canvas.width / canvas.height

struct Grid {
    res: vec2u,
    buf_size: vec2u,
    r_delta: vec2f,
    half_r_delta: vec2f,
} // size = 32

struct Constants {
    velocity_grid: Grid,
    dye_grid: Grid,                                 // 32
    aspect_ratio: f32,                              // 64
    dt: f32,                                        // 68
    jacobi_rhs: f32,                                // 72
    jacobi_x: f32,                                  // 76
    jacobi_y: f32,                                  // 80
    force_strength: f32,                            // 84
}

struct Mouse {
    position: vec2f, // in normalized coordinates
    displacement: vec2f,
    color: vec4f,
    sq_radius: f32,
}

@group(0) @binding(0)
var<uniform> mouse: Mouse;

@group(0) @binding(1)
var<uniform> c: Constants;

@group(1) @binding(0)
var<storage, read_write> u0: array<vec2f>;

@group(1) @binding(1)
var<storage, read_write> u1: array<vec2f>;

@group(2) @binding(0)
var<storage, read_write> s0: array<vec4f>;

@group(2) @binding(1)
var<storage, read_write> s1: array<vec4f>;

@group(3) @binding(0)
var<storage, read_write> p0: array<f32>;

@group(3) @binding(1)
var<storage, read_write> p1: array<f32>;

@group(3) @binding(2)
var<storage, read_write> u_divergence: array<f32>;

fn mix2d_f(a00: f32, a01: f32, a10: f32, a11: f32, w: vec2f) -> f32 {
    return mix(mix(a00, a01, w.y), mix(a10, a11, w.y), w.x);
}

fn mix2d_vec2f(a00: vec2f, a01: vec2f, a10: vec2f, a11: vec2f, w: vec2f) -> vec2f {
    return mix(mix(a00, a01, w.y), mix(a10, a11, w.y), w.x);
}

fn mix2d_vec4f(a00: vec4f, a01: vec4f, a10: vec4f, a11: vec4f, w: vec2f) -> vec4f {
    return mix(mix(a00, a01, w.y), mix(a10, a11, w.y), w.x);
}

fn normalized_coords(grid_coords: vec2u, grid: Grid) -> vec2f {
    let zero_one_coords = (vec2f(grid_coords) + vec2f(0.5, 0.5)) / vec2f(grid.res);
    return vec2f(zero_one_coords.x * c.aspect_ratio, zero_one_coords.y);
}

fn grid_coords(normalized_coords: vec2f, grid: Grid) -> vec2f {
    return vec2f(
        normalized_coords.x * grid.r_delta.x,
        normalized_coords.y * grid.r_delta.y,
    );
}

fn clamp(nc: vec2f) -> vec2f {
    return max(vec2f(0.0, 0.0), min(vec2f(c.aspect_ratio, 1.0), nc));
}

fn buffer_index(grid_coords: vec2u, grid: Grid) -> u32 {
    return (grid_coords.y + 1) * grid.buf_size.x + (grid_coords.x + 1);
}

fn interpolate_s0(coords: vec2f) -> vec4f {
    // The + (0.5, 0.5) is because the grid coordinates are at the centers of the grid cells,
    // and we have an array index offset due to the boundary.
    let upper_left = vec2u(coords + vec2f(0.5, 0.5));
    let mix_weight = coords + vec2f(0.5, 0.5) - vec2f(upper_left);

    let i = upper_left.y * c.dye_grid.buf_size.x + upper_left.x;
    return mix2d_vec4f(s0[i], s0[i + c.dye_grid.buf_size.x], s0[i + 1],
        s0[i + c.dye_grid.buf_size.x + 1], mix_weight);
}

fn interpolate_u0(coords: vec2f) -> vec2f {
    let upper_left = vec2u(coords + vec2f(0.5, 0.5));
    let mix_weight = coords + vec2f(0.5, 0.5) - vec2f(upper_left);

    let i = upper_left.y * c.velocity_grid.buf_size.x + upper_left.x;
    return mix2d_vec2f(u0[i], u0[i + c.velocity_grid.buf_size.x], u0[i + 1],
        u0[i + c.velocity_grid.buf_size.x + 1], mix_weight);
}

@compute @workgroup_size(8, 8)
fn add_force(
    @builtin(global_invocation_id) id: vec3u,
) {
    let nc = normalized_coords(id.xy, c.velocity_grid);
    let sq_d = dot(nc - mouse.position, nc - mouse.position);
    if sq_d < mouse.sq_radius {
        u0[buffer_index(id.xy, c.velocity_grid)] += (f32(mouse.sq_radius - sq_d) / mouse.sq_radius)
            * mouse.displacement * c.force_strength;
    }
}

// The dissipation is not quite physical, but makes the fluid eventually calm down
// and prevents blowups.
@compute @workgroup_size(8, 8)
fn transport_dissipate_velocity(
    @builtin(global_invocation_id) id: vec3u,
) {
    let i = buffer_index(id.xy, c.velocity_grid);
    let nc = normalized_coords(id.xy, c.velocity_grid);
    let k1 = -c.dt * u0[i];
    let k2 = -c.dt * interpolate_u0(grid_coords(clamp(nc + 0.5 * k1), c.velocity_grid));
    let previous_position = grid_coords(clamp(nc + k2), c.velocity_grid);
    u1[i] = interpolate_u0(previous_position) * 0.999;
}

@compute @workgroup_size(8, 8)
fn divergence(@builtin(global_invocation_id) id: vec3u) {
    let i = buffer_index(id.xy, c.velocity_grid);
    u_divergence[i] = (u0[i + 1].x - u0[i - 1].x) * c.velocity_grid.half_r_delta.x
        + (u0[i + c.velocity_grid.buf_size.x].y - u0[i - c.velocity_grid.buf_size.x].y) * c.velocity_grid.half_r_delta.y;
}

@compute @workgroup_size(8, 8)
fn jacobi_pressure(@builtin(global_invocation_id) id: vec3u) {
    let i = buffer_index(id.xy, c.velocity_grid);

    p1[i] = c.jacobi_rhs * u_divergence[i]
    + c.jacobi_x * (p0[i + 1] + p0[i - 1])
    + c.jacobi_y * (p0[i + c.velocity_grid.buf_size.x] + p0[i - c.velocity_grid.buf_size.x]);
}

@compute @workgroup_size(8, 8)
fn sub_pressure_gradient(@builtin(global_invocation_id) id: vec3u) {
    let i = buffer_index(id.xy, c.velocity_grid);
    let del_x = (p0[i + 1] - p0[i - 1]) * c.velocity_grid.half_r_delta.x;
    let del_y = (p0[i + c.velocity_grid.buf_size.x] - p0[i - c.velocity_grid.buf_size.x]) * c.velocity_grid.half_r_delta.y;
    u0[i] -= vec2f(del_x, del_y);
}

@compute @workgroup_size(64)
fn pressure_boundary(@builtin(global_invocation_id) id: vec3u) {
    if id.x < c.velocity_grid.res.x {
        let top_i = id.x + 1;
        p0[top_i] = p0[top_i + c.velocity_grid.buf_size.x];
        let bottom_i = top_i + (c.velocity_grid.res.y + 1) * c.velocity_grid.buf_size.x;
        p0[bottom_i] = p0[bottom_i - c.velocity_grid.buf_size.x];
    }
    if id.x < c.velocity_grid.res.y {
        let left_i = (id.x + 1) * c.velocity_grid.buf_size.x;
        p0[left_i] = p0[left_i + 1];
        let right_i = left_i + c.velocity_grid.buf_size.x - 1;
        p0[right_i] = p0[right_i - 1];
    }
}

@compute @workgroup_size(64)
fn velocity_boundary(@builtin(global_invocation_id) id: vec3u) {
    if id.x < c.velocity_grid.res.x {
        let top_i = id.x + 1;
        u0[top_i] = -u0[top_i + c.velocity_grid.buf_size.x];
        let bottom_i = top_i + (c.velocity_grid.res.y + 1) * c.velocity_grid.buf_size.x;
        u0[bottom_i] = -u0[bottom_i - c.velocity_grid.buf_size.x];
    }
    if id.x < c.velocity_grid.res.y {
        let left_i = (id.x + 1) * c.velocity_grid.buf_size.x;
        u0[left_i] = -u0[left_i + 1];
        let right_i = left_i + c.velocity_grid.buf_size.x - 1;
        u0[right_i] = -u0[right_i - 1];
    }
}

@compute @workgroup_size(8, 8)
fn add_dye(@builtin(global_invocation_id) id: vec3u) {
    let nc = normalized_coords(id.xy, c.dye_grid);
    let sq_d = dot(nc - mouse.position, nc - mouse.position);
    if sq_d < mouse.sq_radius {
        let i = buffer_index(id.xy, c.dye_grid);
        s0[i] += 0.1 * mouse.color * (mouse.sq_radius - sq_d) / mouse.sq_radius;
    }
}

@compute @workgroup_size(8, 8)
fn transport_dissipate_dye(
    @builtin(global_invocation_id) id: vec3u,
) {
    let nc = normalized_coords(id.xy, c.dye_grid);
    let velocity_grid_coords = grid_coords(nc, c.velocity_grid);
    let k1 = -c.dt * interpolate_u0(velocity_grid_coords);
    let k2 = -c.dt * interpolate_u0(grid_coords(clamp(nc + 0.5 * k1), c.velocity_grid));
    let previous_position = grid_coords(clamp(nc + k2), c.dye_grid);
    s1[buffer_index(id.xy, c.dye_grid)] = interpolate_s0(previous_position) * 0.993;
}
