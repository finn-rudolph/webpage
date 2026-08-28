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
var s0: texture_storage_2d<r32float, read_write>;

@group(0) @binding(4)
var s1: texture_storage_2d<r32float, read_write>;

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
}

fn add_force(id: vec3u) {
}

fn add_source(id: vec3u) {
    let dx = i32(id.x) - 128;
    let dy = i32(id.y) - 128;
    let dis_squared = dx * dx + dy * dy;
    if dis_squared < 100 {
        s1[vec2u(id.y, id.x)] = s0[id.y * params.width + id.x] + f32(100 - dis_squared);
    }
}
