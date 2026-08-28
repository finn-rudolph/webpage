struct Params {
    width: u32,
    height: u32,
    radius: f32,
    dt: f32,
}

struct Mouse {
    mousePosition: vec2f,
    mouseDown: u32, // just a bool, but for alignment
}

@group(0) @binding(0)
var<uniform> mouse: Mouse;

@group(0) @binding(1)
var<storage, read_write> u0: array<vec2f>;

@group(0) @binding(2)
var<storage, read_write> u1: array<vec2f>;

@group(0) @binding(3)
var<storage, read_write> s0: array<f32>;

@group(0) @binding(4)
var<storage, read_write> s1: array<f32>;

@group(0) @binding(5)
var<uniform> params: Params;

@group(0) @binding(20)
var<storage, read_write> test: array<f32>;

@compute @workgroup_size(8, 8)
fn update_velocity(
    @builtin(global_invocation_id) id: vec3u,
) {
}

@compute @workgroup_size(8, 8)
fn update_scalar_field(
    @builtin(global_invocation_id) id: vec3u,
) {
    s1[id.y * params.width + id.x] = params.dt;
}

fn add_force(id: vec3u) {
}

fn add_source(id: vec3u) {
}
