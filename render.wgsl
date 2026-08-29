struct Params {
    pixelWidth: u32, // number of physical pixels
    pixelHeight: u32,
}

@group(0) @binding(0)
var s: texture_2d<f32>;

@group(0) @binding(1)
var<uniform> params: Params;

fn mix2d_f(a00: f32, a01: f32, a10: f32, a11: f32, w: vec2f) -> f32 {
    return mix(mix(a00, a01, w.y), mix(a10, a11, w.y), w.x);
}

@vertex
fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    let positions = array<vec2f, 3>(vec2f(-1, 1), vec2f(3, 1), vec2f(-1, -3));
    return vec4f(positions[i], 0.0, 1.0);
}

@fragment
fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
    let coords = position.xy / vec2f(f32(params.pixelWidth), f32(params.pixelHeight));
    let upper_left = vec2u(coords * vec2f(textureDimensions(s)));
    let mix_weight = coords * vec2f(textureDimensions(s)) - vec2f(upper_left);

    return vec4f(0.529, 0.0, 0.929, mix2d_f(
        textureLoad(s, upper_left, 0).r,
        textureLoad(s, upper_left + vec2u(0, 1), 0).r,
        textureLoad(s, upper_left + vec2u(1, 0), 0).r,
        textureLoad(s, upper_left + vec2u(1, 1), 0).r,
        mix_weight
    ));
}
