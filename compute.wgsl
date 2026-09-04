struct Grid {
    res: vec2u,
    buf_size: vec2u,
    r_delta: vec2f,
    half_r_delta: vec2f,
} // size = 32

struct Constants {
    velocity_grid: Grid,
    dye_grid: Grid,                                 // 32
    dissipation_rate: f32,                          // 64
    aspect_ratio: f32,                              // 68
    dt: f32,                                        // 72
    jacobi_rhs: f32,                                // 76
    jacobi_x: f32,                                  // 80
    jacobi_y: f32,                                  // 84
}

struct Mouse {
    position: vec2f, // in normalized coords
    displacement: vec2f, // already scaled by dt
    color: vec4f,
    sq_radius: f32,
}

@group(0) @binding(0)
var<uniform> mouse: Mouse;
// TODO: account for spacing between cells, so that the total amount of dye is
// independent of the screen and simulation
@group(0) @binding(1)
var<uniform> c: Constants;

// All buffers for grid data are padded by 1 in x and y direction to handle
// boundary conditions. When simulation grid coordinates are passed around,
// they are 0-based, however. We only add the +1 when we really access data.

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

// Normalized coordinates are the "physical coordinates". They range from 0 to 1 on
// the y-axis and from 0 to aspect_ratio on the x-axis. A circle in these coordinates
// appears as a circle on the screen.
// Simulation coordinates are the integer coordinates of the simulation grid.
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

fn buffer_index(grid_coords: vec2u, grid: Grid) -> u32 {
    return (grid_coords.y + 1) * grid.buf_size.x + (grid_coords.x + 1);
}

fn interpolate_s0(coords: vec2f) -> vec4f {
    let upper_left = vec2u(coords - vec2f(0.5, 0.5));
    let mix_weight = coords - vec2f(0.5, 0.5) - vec2f(upper_left);

    let i = buffer_index(upper_left, c.dye_grid);
    return mix2d_vec4f(s0[i], s0[i + c.dye_grid.buf_size.x], s0[i + 1],
        s0[i + c.dye_grid.buf_size.x + 1], mix_weight);
}

fn interpolate_u0(coords: vec2f) -> vec2f {
    let upper_left = vec2u(coords - vec2f(0.5, 0.5));
    let mix_weight = coords - vec2f(0.5, 0.5) - vec2f(upper_left);

    let i = buffer_index(upper_left, c.velocity_grid);
    return mix2d_vec2f(u0[i], u0[i + c.velocity_grid.buf_size.x], u0[i + 1],
        u0[i + c.velocity_grid.buf_size.x + 1], mix_weight);
}

// The old data is always in s0 or u0, respectively. Whether the new data
// is in u0/s0 or u1/s1 depends on the function.

@compute @workgroup_size(8, 8)
fn add_force(
    @builtin(global_invocation_id) id: vec3u,
) {
    let nc = normalized_coords(id.xy, c.velocity_grid);
    let sq_d = dot(nc - mouse.position, nc - mouse.position);
    if sq_d < mouse.sq_radius {
        u0[buffer_index(id.xy, c.velocity_grid)] += (f32(mouse.sq_radius - sq_d) / mouse.sq_radius) * mouse.displacement;
    }
}

// This function also slightly dissipates the velocity. This is not physical but ensures that
// the velocity field eventually calms down.
@compute @workgroup_size(8, 8)
fn transport_velocity(
    @builtin(global_invocation_id) id: vec3u,
) {
    let i = buffer_index(id.xy, c.velocity_grid);
    let nc = normalized_coords(id.xy, c.velocity_grid);
    let k1 = -c.dt * u0[i];
    let k2 = -c.dt * interpolate_u0(grid_coords(clamp(nc + 0.5 * k1), c.velocity_grid));
    let previous_position = grid_coords(clamp(nc + k2), c.velocity_grid);
    u1[i] = interpolate_u0(previous_position) * c.dissipation_rate;
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

fn clamp(nc: vec2f) -> vec2f {
    return max(vec2f(0.0, 0.0), min(vec2f(c.aspect_ratio, 1.0), nc));
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
fn transport_dye(
    @builtin(global_invocation_id) id: vec3u,
) {
    let nc = normalized_coords(id.xy, c.dye_grid);
    let velocity_grid_coords = grid_coords(nc, c.velocity_grid);
    let k1 = -c.dt * interpolate_u0(velocity_grid_coords);
    let k2 = -c.dt * interpolate_u0(grid_coords(clamp(nc + 0.5 * k1), c.velocity_grid));
    let previous_position = grid_coords(clamp(nc + k2), c.dye_grid);
    s1[buffer_index(id.xy, c.dye_grid)] = interpolate_s0(previous_position);
}

// traces a particle at `ìnitial_position` backwards through `u0` for time `params.dt`
// and returns the position in normalized coords.
// `initial_position` should be in normalized coordinates.
// fn trace_particle(initial_position: vec2f) -> vec2f {
    // Euler

    // let nc = normalized_coords(initial_position);
    // let k = -params.dt * u0[(initial_position.y + 1) * (params.simulation_size.x + 2) + initial_position.x + 1];
    // return max(vec2f(0.0, 0.0), min(vec2f(c.aspect_ratio, 1.0), nc + k));

    // adaptive second-order Runge-Kutta

    // var current_position = normalized_coords(initial_position);
    // var dt = params.dt;
    // var iterations = 0;
    // while dt > 0.0 && iterations < 3 {
    //     let k1 = -dt * u0[(initial_position.y + 1) * (params.simulation_size.x + 2) + initial_position.x + 1];
    //     let euler_step = current_position - k1;

    //     var overshoot_frac = 0.0;
    //     if euler_step.x < 0 { overshoot_frac = -euler_step.x / k1.x; }
    //     else if euler_step.x > c.aspect_ratio { overshoot_frac = (euler_step.x - c.aspect_ratio) / k1.x; }
    //     if euler_step.y < 0 { overshoot_frac = max(overshoot_frac, -euler_step.y / k1.y); }
    //     else if euler_step.y > 1.0 { overshoot_frac = max(overshoot_frac, (1.0 - euler_step.y) / k1.y); }

    //     let effective_dt = dt * (1.0 - overshoot_frac);
    //     let k2 = -effective_dt * interpolate_u0(simulation_coords(current_position + 0.5 * (1.0 - overshoot_frac) * k1));
    //     current_position = max(vec2f(0.0, 0.0), min(vec2f(c.aspect_ratio, 1.0), current_position + k2));
    //     dt -= effective_dt;
    //     iterations += 1;
    // }

    // return current_position;

    // second-order Runge-Kutta

//     let velocity_grid_coords = grid_coords(initial_position, c.velocity_grid);
//     let k1 = -c.dt * interpolate_u0(velocity_grid_coords);
//     let k2 = -c.dt * interpolate_u0(grid_coords(initial_position + 0.5 * k1, c.velocity_grid));
//     return max(vec2f(0.0, 0.0), min(vec2f(c.aspect_ratio, 1.0), initial_position + k2));
// }

@compute @workgroup_size(8, 8)
fn dissipate(@builtin(global_invocation_id) id: vec3u) {
    let i = buffer_index(id.xy, c.dye_grid);
    s0[i].r *= c.dissipation_rate;
    s0[i].g *= c.dissipation_rate;
    s0[i].b *= c.dissipation_rate;
}
