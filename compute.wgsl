enable f16;

struct Params {
    simulation_size: vec2u,
    mouse_radius: f32,
    dt: f16,
}

// simulation_size = number of simulation cells in each axis (points for which we store a velocity etc.)

struct CoordinateConstants {
    aspect_ratio: f32,
    r_delta_x: f32, // 1 / delta_x
    r_delta_y: f32, // 1 / delta_y
    half_r_sum_r_sq_delta_x_r_sq_delta_y: f16, // 1 / (2 * (1 / delta_x^2 + 1 / delta_y^2))
    half_div_sq_delta_y_sum_sq_delta_x_sq_delta_y: f16, // delta_y^2 / (2 * (delta_x^2 + delta_y^2))
    half_div_sq_delta_x_sum_sq_delta_x_sq_delta_y: f16, // delta_x^2 / (2 * (delta_x^2 + delta_y^2))
    half_r_delta_x: f16, // 1 / (2 * delta_x)
    half_r_delta_y: f16, // 1 / (2 * delta_y)
}

// half_r_delta_x = 1/(2 * delta_x) = simulation_size.x / (2 * aspect_ratio)

struct Mouse {
    position: vec2f, // in normalized coords
    displacement: vec2f, // already scaled by dt
    is_down: u32, // just a bool
}

@group(0) @binding(0)
var<uniform> mouse: Mouse;

@group(0) @binding(1)
var<uniform> params: Params;

@group(0) @binding(2)
var<uniform> c: CoordinateConstants;

// All buffers for grid data are padded by 1 in x and y direction to handle
// boundary conditions. When simulation grid coordinates are passed around,
// they are 0-based, however. We only add the +1 when we really access data.

@group(1) @binding(0)
var<storage, read_write> u0: array<vec2<f16>>;

@group(1) @binding(1)
var<storage, read_write> u1: array<vec2<f16>>;

@group(2) @binding(0)
var<storage, read_write> s0: array<f16>;

@group(2) @binding(1)
var<storage, read_write> s1: array<f16>;

@group(3) @binding(0)
var<storage, read_write> p0: array<f16>;

@group(3) @binding(1)
var<storage, read_write> p1: array<f16>;

@group(3) @binding(2)
var<storage, read_write> u_divergence: array<f16>;

fn mix2d_f(a00: f16, a01: f16, a10: f16, a11: f16, w: vec2<f16>) -> f16 {
    return mix(mix(a00, a01, w.y), mix(a10, a11, w.y), w.x);
}

fn mix2d_vec2f16(a00: vec2<f16>, a01: vec2<f16>, a10: vec2<f16>, a11: vec2<f16>, w: vec2<f16>) -> vec2<f16> {
    return mix(mix(a00, a01, w.y), mix(a10, a11, w.y), w.x);
}

// Normalized coordinates are the "physical coordinates". They range from 0 to 1 on
// the y-axis and from 0 to aspect_ratio on the x-axis. A circle in these coordinates
// appears as a circle on the screen.
// Simulation coordinates are the integer coordinates of the simulation grid.
fn normalized_coords(simulation_coords: vec2u) -> vec2f {
    let zero_one_coords = (vec2f(simulation_coords) + vec2f(0.5, 0.5)) / vec2f(params.simulation_size);
    return vec2f(zero_one_coords.x * c.aspect_ratio, zero_one_coords.y);
}

fn simulation_coords(normalized_coords: vec2f) -> vec2f {
    return vec2f(
        normalized_coords.x * c.r_delta_x,
        normalized_coords.y * c.r_delta_y,
    );
}

fn interpolate_s0(coords: vec2f) -> f16 {
    let upper_left = vec2u(coords + vec2f(0.5, 0.5));
    let mix_weight = vec2<f16>(coords + vec2f(0.5, 0.5) - vec2f(upper_left));

    let width = params.simulation_size.x + 2;
    let i = upper_left.y * width + upper_left.x;

    return mix2d_f(s0[i], s0[i + width], s0[i + 1], s0[i + width + 1], mix_weight);
}

// one cannot pass arrays to functions
fn interpolate_u0(coords: vec2f) -> vec2<f16> {
    let upper_left = vec2u(coords + vec2f(0.5, 0.5));
    let mix_weight = vec2<f16>(coords + vec2f(0.5, 0.5) - vec2f(upper_left));

    let width = params.simulation_size.x + 2;
    let i = upper_left.y * width + upper_left.x;

    return mix2d_vec2f16(u0[i], u0[i + width], u0[i + 1], u0[i + width + 1], mix_weight);
}

// The old data is always in s0 or u0, respectively. Whether the new data
// is in u0/s0 or u1/s1 depends on the function.

@compute @workgroup_size(8, 8)
fn add_force(
    @builtin(global_invocation_id) id: vec3u,
) {
    if mouse.is_down == 1 {
        let nc = normalized_coords(id.xy);
        let d = distance(nc, mouse.position);
        if d < params.mouse_radius {
            let i = (id.y + 1) * (params.simulation_size.x + 2) + id.x + 1;
            u0[i] += 2.0 * vec2<f16>(((params.mouse_radius - d) / params.mouse_radius) * mouse.displacement);
        }
    }
}

@compute @workgroup_size(8, 8)
fn transport_velocity(
    @builtin(global_invocation_id) id: vec3u,
) {
    let previous_position = simulation_coords(trace_particle(id.xy));
    u1[(id.y + 1) * (params.simulation_size.x + 2) + id.x + 1] = interpolate_u0(previous_position);
}

@compute @workgroup_size(8, 8)
fn divergence(@builtin(global_invocation_id) id: vec3u) {
    let width = params.simulation_size.x + 2;
    let i = (id.y + 1) * width + id.x + 1;
    u_divergence[i] = ((u0[i + 1].x - u0[i - 1].x) * c.half_r_delta_x
        + (u0[i + width].y - u0[i - width].y) * c.half_r_delta_y);
}

@compute @workgroup_size(8, 8)
fn jacobi_pressure(@builtin(global_invocation_id) id: vec3u) {
    let width = params.simulation_size.x + 2;
    let i = (id.y + 1) * width + id.x + 1;

    p1[i] = -c.half_r_sum_r_sq_delta_x_r_sq_delta_y * u_divergence[i]
    + c.half_div_sq_delta_y_sum_sq_delta_x_sq_delta_y * (p0[i + 1] + p0[i - 1])
    + c.half_div_sq_delta_x_sum_sq_delta_x_sq_delta_y * (p0[i + width] + p0[i - width]);
}

@compute @workgroup_size(8, 8)
fn sub_pressure_gradient(@builtin(global_invocation_id) id: vec3u) {
    let width = params.simulation_size.x + 2;
    let i = (id.y + 1) * width + id.x + 1;

    let del_x = (p0[i + 1] - p0[i - 1]) * c.half_r_delta_x;
    let del_y = (p0[i + width] - p0[i - width]) * c.half_r_delta_y;
    u0[i] -= vec2<f16>(del_x, del_y);
}

@compute @workgroup_size(64)
fn pressure_boundary_h(@builtin(global_invocation_id) id: vec3u) {
    let width = params.simulation_size.x + 2;
    let top_i = id.x + 1;
    p0[top_i] = p0[top_i + width];
    let bottom_i = top_i + (params.simulation_size.y + 1) * width;
    p0[bottom_i] = p0[bottom_i - width];
}

@compute @workgroup_size(64)
fn pressure_boundary_v(@builtin(global_invocation_id) id: vec3u) {
    let width = params.simulation_size.x + 2;
    let left_i = (id.x + 1) * width;
    p0[left_i] = p0[left_i + 1];
    let right_i = left_i + width - 1;
    p0[right_i] = p0[right_i - 1];
}

@compute @workgroup_size(64)
fn velocity_boundary_h(@builtin(global_invocation_id) id: vec3u) {
    let width = params.simulation_size.x + 2;
    let top_i = id.x + 1;
    u0[top_i] = -u0[top_i + width];
    let bottom_i = top_i + (params.simulation_size.y + 1) * width;
    u0[bottom_i] = -u0[bottom_i - width];
}

@compute @workgroup_size(64)
fn velocity_boundary_v(@builtin(global_invocation_id) id: vec3u) {
    let width = params.simulation_size.x + 2;
    let left_i = (id.x + 1) * width;
    u0[left_i] = -u0[left_i + 1];
    let right_i = left_i + width - 1;
    u0[right_i] = -u0[right_i - 1];
}

@compute @workgroup_size(8, 8)
fn add_source(@builtin(global_invocation_id) id: vec3u) {
    if mouse.is_down == 1 {
        let nc = normalized_coords(id.xy);
        let d = distance(nc, mouse.position);
        if d < params.mouse_radius {
            let i = (id.y + 1) * (params.simulation_size.x + 2) + id.x + 1;
            s0[i] += f16((params.mouse_radius - d) / (10.0 * params.mouse_radius));
        }
    }
}

@compute @workgroup_size(8, 8)
fn transport_scalar_field(
    @builtin(global_invocation_id) id: vec3u,
) {
    let previous_position = simulation_coords(trace_particle(id.xy));
    s1[(id.y + 1) * (params.simulation_size.x + 2) + id.x + 1] = interpolate_s0(previous_position);
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
    let k1 = -params.dt * u0[(initial_position.y + 1) * (params.simulation_size.x + 2) + initial_position.x + 1];
    let k2 = -params.dt * interpolate_u0(simulation_coords(nc + 0.5 * vec2f(k1)));
    return max(vec2f(0.0, 0.0), min(vec2f(c.aspect_ratio, 1.0), nc + vec2f(k2)));
}

@compute @workgroup_size(8,8)
fn diffuse_velocity() {
}
