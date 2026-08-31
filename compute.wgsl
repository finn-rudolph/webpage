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
    is_down: u32, // just a bool
}

@group(0) @binding(0)
var<uniform> mouse: Mouse;

@group(0) @binding(1)
var<uniform> params: Params;

@group(0) @binding(2)
var<uniform> c: CoordinateConstants;

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
    let upper_left = vec2u(coords - vec2f(0.5, 0.5));
    let mix_weight = coords - vec2f(0.5, 0.5) - vec2f(upper_left);

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
    let upper_left = vec2u(coords - vec2f(0.5, 0.5));
    let mix_weight = coords - vec2f(0.5, 0.5) - vec2f(upper_left);

    let i = upper_left.y * params.simulation_size.x + upper_left.x;
    let width = params.simulation_size.x;

    return mix2d_vec2f(u0[i], u0[i + width], u0[i + 1], u0[i + width + 1], mix_weight);
}

// The old data is always in s0 or u0, respectively. Whether the new data
// is in u0/s0 or u1/s1 depends on the function.

@compute @workgroup_size(8, 8)
fn add_force(
    @builtin(global_invocation_id) id: vec3u,
) {
    u0[id.y * params.simulation_size.x + id.x].x += 0.000001;
}

@compute @workgroup_size(8, 8)
fn transport_velocity(
    @builtin(global_invocation_id) id: vec3u,
) {
    let previous_position = simulation_coords(trace_particle(id.xy));
    u1[id.y * params.simulation_size.x + id.x] = interpolate_u0(previous_position);
}

@compute @workgroup_size(8, 8)
fn divergence(@builtin(global_invocation_id) id: vec3u) {
    let width = params.simulation_size.x;
    let i = id.y * width + id.x;
    u_divergence[i] = ((u0[i + 1].x - u0[i - 1].x) * c.half_r_delta_x
        + (u0[i + width].y - u0[i - width].y) * c.half_r_delta_y);
}

@compute @workgroup_size(8, 8)
fn jacobi_pressure(@builtin(global_invocation_id) id: vec3u) {
    let width = params.simulation_size.x;
    let i = id.y * width + id.x;

    p1[i] = -c.half_r_sum_r_sq_delta_x_r_sq_delta_y * u_divergence[i]
    + c.half_div_sq_delta_y_sum_sq_delta_x_sq_delta_y * (p0[i + 1] + p0[i - 1])
    + c.half_div_sq_delta_x_sum_sq_delta_x_sq_delta_y * (p0[i + width] + p0[i - width]);
}

@compute @workgroup_size(8, 8)
fn sub_pressure_gradient(@builtin(global_invocation_id) id: vec3u) {
    let width = params.simulation_size.x;
    let i = id.y * width + id.x;

    let del_x = (p0[i + 1] - p0[i - 1]) * c.half_r_delta_x;
    let del_y = (p0[i + width] - p0[i - width]) * c.half_r_delta_y;
    u0[i] -= vec2f(del_x, del_y);
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
            let value = textureLoad(s0, id.xy).r;
            textureStore(s0, id.xy, vec4f(value + f32(params.mouse_radius - d) / (10.0 * params.mouse_radius), 0.0, 0.0, 0.0));
        }
    }
}

@compute @workgroup_size(8, 8)
fn transport_scalar_field(
    @builtin(global_invocation_id) id: vec3u,
) {
    let previous_position = simulation_coords(trace_particle(id.xy));
    textureStore(s1, id.xy, vec4f(interpolate_2d_f(s0, previous_position), 0.0, 0.0, 0.0));
}

// traces a particle at `ìnitial_position` backwards through `u0` for time `params.dt`
// and returns the position in normalized coords
fn trace_particle(initial_position: vec2u) -> vec2f {
    let k1 = -params.dt * u0[initial_position.y * params.simulation_size.x + initial_position.x];
    let nc = normalized_coords(initial_position);
    let k2 = -params.dt * interpolate_u0(nc + 0.5 * k1);
    return nc + k2;
}
