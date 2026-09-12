// Some facts about the data here:
//
//   *  The velocity, pressure and related buffers are padded by 1 in x and y direction to handle
//      boundary conditions. When grid coordinates are passed around, they are 0-based.
//      We only add the + 1 when accessing data.
//
//   *  The current (or input) data is always in s0, u0 or p0. Whether the new data
//      is written to (u/s/p)0 or (u/s/p)1 depends on the shader.
//
//   *  Coordinate systems:
//       -  Normalized coordinates: [0, aspect_ratio] x [0, 1]
//       -  Grid coordinates: [0, resolution.x] x [0, resolution.y]. In general they are not the same
//          for u and s, since u and s may have different resolutions.
//       -  Pixel coordinates: [0, canvas.width] x [0, canvas.height] The screen pixel coordinates.
//          aspect_ratio := canvas.width / canvas.height

struct Constants {
    velocity_res: vec2u,
    velocity_r_delta: vec2f,                        // 8
    dye_res: vec2u,                                 // 16
    dye_r_delta: vec2f,                             // 24
    aspect_ratio: f32,                              // 32
    dt: f32,                                        // 36
    jacobi_rhs: f32,                                // 40
    jacobi_x: f32,                                  // 44
    jacobi_y: f32,                                  // 48
    velocity_decay_rate: f32,                       // 52
    dye_decay_rate: f32,                            // 56
    force_strength: f32,                            // 60
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
var s0: texture_2d<f32>;

@group(2) @binding(1)
var s1: texture_storage_2d<rgba16float, write>;

@group(2) @binding(2)
var linear_sampler: sampler;

@group(3) @binding(0)
var<storage, read_write> p0: array<f32>;

@group(3) @binding(1)
var<storage, read_write> p1: array<f32>;

@group(3) @binding(2)
var<storage, read_write> u_divergence: array<f32>;

fn mix2d_vec2f(a00: vec2f, a01: vec2f, a10: vec2f, a11: vec2f, w: vec2f) -> vec2f {
    return mix(mix(a00, a01, w.y), mix(a10, a11, w.y), w.x);
}

fn normalized_coords(grid_coords: vec2u, res: vec2u) -> vec2f {
    let zero_one_coords = (vec2f(grid_coords) + vec2f(0.5, 0.5)) / vec2f(res);
    return vec2f(zero_one_coords.x * c.aspect_ratio, zero_one_coords.y);
}

fn grid_coords(normalized_coords: vec2f, r_delta: vec2f) -> vec2f {
    return vec2f(normalized_coords.x * r_delta.x, normalized_coords.y * r_delta.y);
}

fn clamp(nc: vec2f) -> vec2f {
    return max(vec2f(0.0, 0.0), min(vec2f(c.aspect_ratio, 1.0), nc));
}

// for the velocity grid
fn buffer_index(grid_coords: vec2u) -> u32 {
    return (grid_coords.y + 1) * (c.velocity_res.x + 2) + (grid_coords.x + 1);
}

fn interpolate_u0(coords: vec2f) -> vec2f {
    let upper_left = vec2u(coords + vec2f(0.5, 0.5));
    let mix_weight = coords + vec2f(0.5, 0.5) - vec2f(upper_left);

    let i = upper_left.y * (c.velocity_res.x + 2) + upper_left.x;
    return mix2d_vec2f(
        u0[i],
        u0[i + c.velocity_res.x + 2],
        u0[i + 1],
        u0[i + c.velocity_res.x + 3],
        mix_weight
    );
}

@compute @workgroup_size(8, 8)
fn add_force(
    @builtin(global_invocation_id) id: vec3u,
) {
    let nc = normalized_coords(id.xy, c.velocity_res);
    let sq_d = dot(nc - mouse.position, nc - mouse.position);
    u0[buffer_index(id.xy)] += exp(-sq_d * c.force_strength / mouse.sq_radius) * mouse.displacement;
}

// The dissipation is not quite physical, but makes the fluid eventually calm down
// and prevents blowups.
@compute @workgroup_size(8, 8)
fn transport_dissipate_velocity(
    @builtin(global_invocation_id) id: vec3u,
) {
    let i = buffer_index(id.xy);
    let nc = normalized_coords(id.xy, c.velocity_res);
    let k1 = -c.dt * u0[i];
    let k2 = -c.dt * interpolate_u0(grid_coords(clamp(nc + 0.5 * k1), c.velocity_r_delta));
    let previous_position = grid_coords(clamp(nc + k2), c.velocity_r_delta);
    u1[i] = interpolate_u0(previous_position) * c.velocity_decay_rate;
}

@compute @workgroup_size(8, 8)
fn divergence(@builtin(global_invocation_id) id: vec3u) {
    let i = buffer_index(id.xy);
    u_divergence[i] = 0.5 * ((u0[i + 1].x - u0[i - 1].x) * c.velocity_r_delta.x +
    (u0[i + c.velocity_res.x + 2].y - u0[i - c.velocity_res.x - 2].y) * c.velocity_r_delta.y);
}

@compute @workgroup_size(8, 8)
fn jacobi_pressure(@builtin(global_invocation_id) id: vec3u) {
    let i = buffer_index(id.xy);

    p1[i] = c.jacobi_rhs * u_divergence[i]
    + c.jacobi_x * (p0[i + 1] + p0[i - 1])
    + c.jacobi_y * (p0[i + c.velocity_res.x + 2] + p0[i - c.velocity_res.x - 2]);
}

@compute @workgroup_size(8, 8)
fn sub_pressure_gradient(@builtin(global_invocation_id) id: vec3u) {
    let i = buffer_index(id.xy);
    u0[i] -= vec2f(
        0.5 * (p0[i + 1] - p0[i - 1]) * c.velocity_r_delta.x,
        0.5 * (p0[i + c.velocity_res.x + 2] - p0[i - c.velocity_res.x - 2]) * c.velocity_r_delta.y
    );
}

@compute @workgroup_size(64)
fn pressure_boundary(@builtin(global_invocation_id) id: vec3u) {
    if id.x < c.velocity_res.x {
        let top_i = id.x + 1;
        p0[top_i] = p0[top_i + c.velocity_res.x + 2];
        let bottom_i = top_i + (c.velocity_res.y + 1) * (c.velocity_res.x + 2);
        p0[bottom_i] = p0[bottom_i - c.velocity_res.x - 2];
    }
    if id.x < c.velocity_res.y {
        let left_i = (id.x + 1) * (c.velocity_res.x + 2);
        p0[left_i] = p0[left_i + 1];
        let right_i = left_i + c.velocity_res.x + 1;
        p0[right_i] = p0[right_i - 1];
    }
}

@compute @workgroup_size(64)
fn velocity_boundary(@builtin(global_invocation_id) id: vec3u) {
    if id.x < c.velocity_res.x {
        let top_i = id.x + 1;
        u0[top_i] = -u0[top_i + c.velocity_res.x + 2];
        let bottom_i = top_i + (c.velocity_res.y + 1) * (c.velocity_res.x + 2);
        u0[bottom_i] = -u0[bottom_i - c.velocity_res.x - 2];
    }
    if id.x < c.velocity_res.y {
        let left_i = (id.x + 1) * (c.velocity_res.x + 2);
        u0[left_i] = -u0[left_i + 1];
        let right_i = left_i + c.velocity_res.x + 1;
        u0[right_i] = -u0[right_i - 1];
    }
}

@compute @workgroup_size(8, 8)
fn update_dye(
    @builtin(global_invocation_id) id: vec3u,
) {
    let nc = normalized_coords(id.xy, c.dye_res);
    let velocity_grid_coords = grid_coords(nc, c.velocity_r_delta);
    let k1 = -c.dt * interpolate_u0(velocity_grid_coords);
    let k2 = -c.dt * interpolate_u0(grid_coords(clamp(nc + 0.5 * k1), c.velocity_r_delta));
    let previous_nc = clamp(nc + k2);
    var value = textureSampleLevel(s0, linear_sampler, vec2f(previous_nc.x / c.aspect_ratio, previous_nc.y), 0.0) * c.dye_decay_rate;

    if mouse.sq_radius > 0 {
        let sq_d = dot(previous_nc - mouse.position, previous_nc - mouse.position);
        value += c.dt * exp(-sq_d / mouse.sq_radius) * mouse.color * c.force_strength * 0.25;
        value /= max(1.0, max(value.r, max(value.g, value.b)) / 4);
    }

    textureStore(s1, id.xy, value);
}
