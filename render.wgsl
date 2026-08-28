struct Params {
    canvasWidth: u32, // number of physical pixels
    canvasHeight: u32,
}

@group(0) @binding(0)
var s: texture_2d<f32>;

@group(0) @binding(1)
var scalarFieldSampler: sampler;

@group(0) @binding(2)
var<uniform> params: Params;

@vertex
fn vertex_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    let positions = array<vec2f, 3>(vec2f(-1, 1), vec2f(3, 1), vec2f(-1, -3));
    return vec4f(positions[i], 0.0, 1.0);
}

@fragment
fn fragment_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
    let coords = position.xy / vec2f(f32(params.canvasWidth), f32(params.canvasHeight));
    let opacity = textureSample(s, scalarFieldSampler, coords).r;
    return vec4f(0.529, 0.0, 0.929, opacity);
}
