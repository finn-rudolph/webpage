struct Constants {
    pixel_res: vec2u, // number of physical pixels
    dye_res: vec2u,
}

@group(0) @binding(0)
var s: texture_2d<f32>;

@group(0) @binding(1)
var<uniform> c: Constants;

@group(0) @binding(2)
var linear_sampler: sampler;

@vertex
fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    let positions = array<vec2f, 3>(vec2f(-1, 1), vec2f(3, 1), vec2f(-1, -3));
    return vec4f(positions[i], 0.0, 1.0);
}

@fragment
fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
    let dye = textureSampleLevel(s, linear_sampler, position.xy / vec2f(c.pixel_res), 0.0);
    return vec4f(1.0, 1.0, 1.0, 1.0) - dye;
}
