// say we solve L(f) = g. the constants are for a jacobi iteration of the form
//          f^(k + 1)_ij = rhs * g_ij
//                         + x * (f^k_(i+1,j) + f^k_(i-1,j))
//                         + y * (f^k_(i,j+1) + f^k_(i,j-1))
struct JacobiConstants {
    rhs: f32,
    x: f32,
    y: f32,
    _pad: f32,
}

struct Constants {
    simulation_size: vec2u,
    buffer_size: vec2u,
    j_pressure: JacobiConstants,                    // 16
    j_diffusion: JacobiConstants,                   // 32
    r_delta: vec2f, // 1 / delta_x                     48
    half_r_delta: vec2f, // 1 / (2 * delta_x)
    aspect_ratio: f32,                              // 64
    viscosity: f32,                                 // 68
    dissipation_rate: f32,                          // 72
    dt: f32,                                        // 76
    delta_x_delta_y: f32,                           // 80
}

// simulation_size = number of simulation cells in each axis (points for which we store a velocity etc.)

struct Mouse {
    position: vec2f, // in normalized coords
    displacement: vec2f, // already scaled by dt
    color: vec4f,
    radius: f32,
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
fn normalized_coords(simulation_coords: vec2u) -> vec2f {
    let zero_one_coords = (vec2f(simulation_coords) + vec2f(0.5, 0.5)) / vec2f(c.simulation_size);
    return vec2f(zero_one_coords.x * c.aspect_ratio, zero_one_coords.y);
}

fn simulation_coords(normalized_coords: vec2f) -> vec2f {
    return vec2f(
        normalized_coords.x * c.r_delta.x,
        normalized_coords.y * c.r_delta.y,
    );
}

// the simulation_coords are 0-based
fn buffer_index(simulation_coords: vec2u) -> u32 {
    return (simulation_coords.y + 1) * c.buffer_size.x + (simulation_coords.x + 1);
}

fn interpolate_s0(coords: vec2f) -> vec4f {
    let upper_left = vec2u(coords - vec2f(0.5, 0.5));
    let mix_weight = coords - vec2f(0.5, 0.5) - vec2f(upper_left);

    let i = buffer_index(upper_left);
    return mix2d_vec4f(s0[i], s0[i + c.buffer_size.x], s0[i + 1], s0[i + c.buffer_size.x + 1], mix_weight);
}

// one cannot pass arrays to functions
fn interpolate_u0(coords: vec2f) -> vec2f {
    let upper_left = vec2u(coords - vec2f(0.5, 0.5));
    let mix_weight = coords - vec2f(0.5, 0.5) - vec2f(upper_left);

    let i = buffer_index(upper_left);
    return mix2d_vec2f(u0[i], u0[i + c.buffer_size.x], u0[i + 1], u0[i + c.buffer_size.x + 1], mix_weight);
}

// The old data is always in s0 or u0, respectively. Whether the new data
// is in u0/s0 or u1/s1 depends on the function.

@compute @workgroup_size(8, 8)
fn add_force(
    @builtin(global_invocation_id) id: vec3u,
) {
    let nc = normalized_coords(id.xy);
    let d = distance(nc, mouse.position);
    if d < mouse.radius {
        u0[buffer_index(id.xy)] += (f32(mouse.radius - d) / mouse.radius) * mouse.displacement;
    }
}

@compute @workgroup_size(8, 8)
fn transport_velocity(
    @builtin(global_invocation_id) id: vec3u,
) {
    let previous_position = simulation_coords(trace_particle(id.xy));
    u1[buffer_index(id.xy)] = interpolate_u0(previous_position);
}

@compute @workgroup_size(8, 8)
fn divergence(@builtin(global_invocation_id) id: vec3u) {
    let i = buffer_index(id.xy);
    u_divergence[i] = ((u0[i + 1].x - u0[i - 1].x) * c.half_r_delta.x
        + (u0[i + c.buffer_size.x].y - u0[i - c.buffer_size.x].y) * c.half_r_delta.y);
}

@compute @workgroup_size(8, 8)
fn jacobi_pressure(@builtin(global_invocation_id) id: vec3u) {
    let i = buffer_index(id.xy);

    p1[i] = c.j_pressure.rhs * u_divergence[i]
    + c.j_pressure.x * (p0[i + 1] + p0[i - 1])
    + c.j_pressure.y * (p0[i + c.buffer_size.x] + p0[i - c.buffer_size.x]);
}

@compute @workgroup_size(8, 8)
fn jacobi_diffuse(@builtin(global_invocation_id) id: vec3u) {
    let i = buffer_index(id.xy);

    u1[i] = c.j_diffusion.rhs * u0[i]
    + c.j_diffusion.x * (u0[i + 1] + u0[i - 1])
    + c.j_diffusion.y * (u0[i + c.buffer_size.x] + u0[i - c.buffer_size.x]);
}

@compute @workgroup_size(8, 8)
fn sub_pressure_gradient(@builtin(global_invocation_id) id: vec3u) {
    let i = buffer_index(id.xy);
    let del_x = (p0[i + 1] - p0[i - 1]) * c.half_r_delta.x;
    let del_y = (p0[i + c.buffer_size.x] - p0[i - c.buffer_size.x]) * c.half_r_delta.y;
    u0[i] -= vec2f(del_x, del_y);
}

@compute @workgroup_size(64)
fn pressure_boundary_h(@builtin(global_invocation_id) id: vec3u) {
    let top_i = id.x + 1;
    p0[top_i] = p0[top_i + c.buffer_size.x];
    let bottom_i = top_i + (c.simulation_size.y + 1) * c.buffer_size.x;
    p0[bottom_i] = p0[bottom_i - c.buffer_size.x];
}

@compute @workgroup_size(64)
fn pressure_boundary_v(@builtin(global_invocation_id) id: vec3u) {
    let left_i = (id.x + 1) * c.buffer_size.x;
    p0[left_i] = p0[left_i + 1];
    let right_i = left_i + c.buffer_size.x - 1;
    p0[right_i] = p0[right_i - 1];
}

@compute @workgroup_size(64)
fn velocity_boundary_h(@builtin(global_invocation_id) id: vec3u) {
    let top_i = id.x + 1;
    u0[top_i] = -u0[top_i + c.buffer_size.x];
    let bottom_i = top_i + (c.simulation_size.y + 1) * c.buffer_size.x;
    u0[bottom_i] = -u0[bottom_i - c.buffer_size.x];
}

@compute @workgroup_size(64)
fn velocity_boundary_v(@builtin(global_invocation_id) id: vec3u) {
    let left_i = (id.x + 1) * c.buffer_size.x;
    u0[left_i] = -u0[left_i + 1];
    let right_i = left_i + c.buffer_size.x - 1;
    u0[right_i] = -u0[right_i - 1];
}

@compute @workgroup_size(8, 8)
fn add_source(@builtin(global_invocation_id) id: vec3u) {
    let nc = normalized_coords(id.xy);
    let d = distance(nc, mouse.position);
    if d < mouse.radius {
        // the delta_x_delta_y ensures that the total amount of dye added does not depend on the size
        // of the simulation grid.
        s0[buffer_index(id.xy)] -= c.dt * (10000000 * c.delta_x_delta_y) * mouse.color * (mouse.radius - d) / mouse.radius;
    }
}

@compute @workgroup_size(8, 8)
fn transport_scalar_field(
    @builtin(global_invocation_id) id: vec3u,
) {
    let previous_position = simulation_coords(trace_particle(id.xy));
    s1[buffer_index(id.xy)] = interpolate_s0(previous_position);
}

// traces a particle at `ìnitial_position` backwards through `u0` for time `params.dt`
// and returns the position in normalized coords.
// `initial_position` must be in simulation grid coordinates.
fn trace_particle(initial_position: vec2u) -> vec2f {
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

    let nc = normalized_coords(initial_position);
    let k1 = -c.dt * u0[buffer_index(initial_position)];
    let k2 = -c.dt * interpolate_u0(simulation_coords(nc + 0.5 * k1));
    return max(vec2f(0.0, 0.0), min(vec2f(c.aspect_ratio, 1.0), nc + k2));
}

@compute @workgroup_size(8, 8)
fn init_dye(@builtin(global_invocation_id) id: vec3u) {
    let i = buffer_index(id.xy);
    s0[i].r = 1.0;
    s0[i].g = 1.0;
    s0[i].b = 1.0;
    s0[i].a = 1.0;
}

@compute @workgroup_size(8, 8)
fn dissipate(@builtin(global_invocation_id) id: vec3u) {
    let i = buffer_index(id.xy);
    s0[i].r += (1.0 - s0[i].r) * c.dissipation_rate;
    s0[i].g += (1.0 - s0[i].g) * c.dissipation_rate;
    s0[i].b += (1.0 - s0[i].b) * c.dissipation_rate;
}
