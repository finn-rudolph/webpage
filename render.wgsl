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

fn simulation_coords(pixel_coords: vec2f) -> vec2f {
    return vec2f(textureDimensions(s).xy) * (pixel_coords / vec2f(f32(params.pixelWidth), f32(params.pixelHeight)));
}

// `coords` are simulation grid coords. They need not be integral, that's why
// we interpolate.
fn interpolate_2d_f(texture: texture_2d<f32>, coords: vec2f) -> f32 {
    let upper_left = vec2u(coords - vec2f(0.5, 0.5));
    let mix_weight = coords - vec2f(upper_left) - vec2f(0.5, 0.5);

    return mix2d_f(
        textureLoad(texture, upper_left, 0).r,
        textureLoad(texture, upper_left + vec2u(0, 1), 0).r,
        textureLoad(texture, upper_left + vec2u(1, 0), 0).r,
        textureLoad(texture, upper_left + vec2u(1, 1), 0).r,
        mix_weight
    );
}

@vertex
fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    let positions = array<vec2f, 3>(vec2f(-1, 1), vec2f(3, 1), vec2f(-1, -3));
    return vec4f(positions[i], 0.0, 1.0);
}

@fragment
fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
    let coords = simulation_coords(position.xy);
    return vec4f(0.529, 0.0, 0.929, interpolate_2d_f(s, coords));
}
