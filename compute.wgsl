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

// The old data is always in s0 or u0, respectively. Whether the new data
// is in u0/s0 or u1/s1 depends on the function.

@compute @workgroup_size(8, 8)
fn add_force(
    @builtin(global_invocation_id) id: vec3u,
) {
}

@compute @workgroup_size(8, 8)
fn add_source(@builtin(global_invocation_id) id: vec3u) {
    let dx = i32(id.x) - 128;
    let dy = i32(id.y) - 128;
    let dis_squared = dx * dx + dy * dy;
    if dis_squared < 100 {
        let p = vec2i(id.xy);
        let value = textureLoad(s0, p).r;
        textureStore(s0, p, vec4f(value + f32(100 - dis_squared), 0.0, 0.0, 0.0));
    }
}
