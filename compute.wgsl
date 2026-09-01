struct Params {
    simulation_size: vec2u,
    mouse_radius: f32,
    dt: f32,
}

// simulation_size = number of simulation cells in each axis (points for which we store a velocity etc.)

struct CoordinateConstants {
    aspect_ratio: f32,
    half_r_sum_r_sq_delta_x_r_sq_delta_y: f32, // 1 / (2 * (1 / delta_x^2 + 1 / delta_y^2))
    half_div_sq_delta_y_sum_sq_delta_x_sq_delta_y: f32, // delta_y^2 / (2 * (delta_x^2 + delta_y^2))
    half_div_sq_delta_x_sum_sq_delta_x_sq_delta_y: f32, // delta_x^2 / (2 * (delta_x^2 + delta_y^2))
    r_delta_x: f32, // 1 / delta_x
    r_delta_y: f32, // 1 / delta_y
    half_r_delta_x: f32, // 1 / (2 * delta_x)
    half_r_delta_y: f32, // 1 / (2 * delta_y)
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
var<storage, read_write> u0: array<vec2f>;

@group(1) @binding(1)
var<storage, read_write> u1: array<vec2f>;

@group(2) @binding(0)
var s0: texture_storage_2d<r32float, read_write>;

@group(2) @binding(1)
var s1: texture_storage_2d<r32float, read_write>;

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

// coords are in [0, params.simulation_size.x/y]
fn interpolate_2d_f(texture: texture_storage_2d<r32float, read_write>, coords: vec2f) -> f32 {
    let upper_left = vec2u(coords + vec2f(0.5, 0.5)); // actually it is -(0.5, 0.5), but there is a boundary
    let mix_weight = coords + vec2f(0.5, 0.5) - vec2f(upper_left);

    return mix2d_f(
        textureLoad(texture, upper_left).r,
        textureLoad(texture, upper_left + vec2u(0, 1)).r,
        textureLoad(texture, upper_left + vec2u(1, 0)).r,
        textureLoad(texture, upper_left + vec2u(1, 1)).r,
        mix_weight
    );
}

// one cannot pass arrays to functions
fn interpolate_u0(coords: vec2f) -> vec2f {
    let upper_left = vec2u(coords + vec2f(0.5, 0.5));
    let mix_weight = coords + vec2f(0.5, 0.5) - vec2f(upper_left);

    let width = params.simulation_size.x + 2;
    let i = upper_left.y * width + upper_left.x;

    return mix2d_vec2f(u0[i], u0[i + width], u0[i + 1], u0[i + width + 1], mix_weight);
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
            u0[i] += 2.0 * (f32(params.mouse_radius - d) / params.mouse_radius) * mouse.displacement;
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
    u0[i] -= vec2f(del_x, del_y);
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
    // let nc = normalized_coords(id.xy);
    // let row = u32(nc.y * f32(12));
    // let residue = nc.y * f32(12) - f32(row);

    // let source_nc = vec2f(params.tracer_diam, params.tracer_diam * (f32(2 * row) + 1));
    // let d = distance(nc, source_nc);
    // if 2.0 * d < params.tracer_diam {
    //     let value = textureLoad(s0, id.xy).r;
    //     textureStore(s0, id.xy, vec4f(value + f32(params.tracer_diam - 2.0 * d) / (10.0 * params.tracer_diam), 0.0, 0.0, 0.0));
    // }

    // The sources of the tracers are at (tracer_diam, tracer_diam * n)
    // for integer n \ge 1.
    // Check whether the current simulation cell

    if mouse.is_down == 1 {
        let nc = normalized_coords(id.xy);
        let d = distance(nc, mouse.position);
        if d < params.mouse_radius {
            let pos_with_boundary = id.xy + vec2u(1, 1);
            let value = textureLoad(s0, pos_with_boundary).r;
            textureStore(s0, pos_with_boundary,
                vec4f(value + f32(params.mouse_radius - d) / (10.0 * params.mouse_radius), 0.0, 0.0, 0.0));
        }
    }
}

@compute @workgroup_size(8, 8)
fn transport_scalar_field(
    @builtin(global_invocation_id) id: vec3u,
) {
    let previous_position = simulation_coords(trace_particle(id.xy));
    textureStore(s1, id.xy + vec2u(1, 1), vec4f(interpolate_2d_f(s0, previous_position), 0.0, 0.0, 0.0));
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
    let k2 = -params.dt * interpolate_u0(simulation_coords(nc + 0.5 * k1));
    return max(vec2f(0.0, 0.0), min(vec2f(c.aspect_ratio, 1.0), nc + k2));
}

@compute @workgroup_size(8,8)
fn diffuse_velocity() {
}
