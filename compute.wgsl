struct Params {
    simulation_size: vec2u, // number of simulation cells in each axis (points for which we store a velocity etc.)
    mouse_radius: f32,
    dt: f32,
    aspect_ratio: f32, // = width / height
}

struct Mouse {
    position: vec2f, // in normalized coords
    is_down: u32, // just a bool
}

@group(0) @binding(0)
var<uniform> mouse: Mouse;

@group(0) @binding(1)
var<storage, read_write> u0: array<vec2f>;

@group(0) @binding(2)
var<storage, read_write> u1: array<vec2f>;

@group(0) @binding(3)
var s0: texture_storage_2d<r32float, read_write>;

@group(0) @binding(4)
var s1: texture_storage_2d<r32float, read_write>;

@group(0) @binding(5)
var<uniform> params: Params;

fn mix2d_v2f(a00: vec2f, a01: vec2f, a10: vec2f, a11: vec2f, w: vec2f) -> vec2f {
    return mix(mix(a00, a01, w.y), mix(a10, a11, w.y), w.x);
}

// Normalized coordinates are the "physical coordinates". They range from 0 to 1 on
// the y-axis and from 0 to aspect_ratio on the x-axis. A circle in these coordinates
// appears as a circle on the screen.
// Simulation coordinates are the integer coordinates of the simulation grid.
fn normalized_coords(simulation_coords: vec2u) -> vec2f {
    let zero_one_coords = vec2f(simulation_coords) / vec2f(params.simulation_size);
    return vec2f(zero_one_coords.x * params.aspect_ratio, zero_one_coords.y);
}

// The old data is always in s0 or u0, respectively. Whether the new data
// is in u0/s0 or u1/s1 depends on the function.

@compute @workgroup_size(8, 8)
fn add_force(
    @builtin(global_invocation_id) id: vec3u,
) {
}

@compute @workgroup_size(8, 8)
fn transport_velocity(
    @builtin(global_invocation_id) id: vec3u,
) {}

@compute @workgroup_size(8, 8)
fn project(@builtin(global_invocation_id) id: vec3u) {}

@compute @workgroup_size(8, 8)
fn add_source(@builtin(global_invocation_id) id: vec3u) {
    if mouse.is_down == 1 {
        let nc = normalized_coords(id.xy);
        let d = distance(nc, mouse.position);
        if d < params.mouse_radius {
            let id_i = vec2i(id.xy);
            let value = textureLoad(s0, id_i).r;
            textureStore(s0, id_i, vec4f(value + f32(params.mouse_radius - d) / params.mouse_radius, 0.0, 0.0, 0.0));
        }
    }
}

@compute @workgroup_size(8, 8)
fn transport_scalar_field(
    @builtin(global_invocation_id) id: vec3u,
) {
    // let previous_position = trace_particle();
}

fn trace_particle(initial_position: vec2f) -> vec2f {
    return initial_position - params.dt * vec2f(200.0, 0.0);
}
