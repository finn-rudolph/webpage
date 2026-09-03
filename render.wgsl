struct Params {
    pixel_size: vec2u, // number of physical pixels
    simulation_size: vec2u,
}

@group(0) @binding(0)
var<storage, read> s: array<vec4f>;

@group(0) @binding(1)
var<uniform> params: Params;

fn mix2d_vec4f(a00: vec4f, a01: vec4f, a10: vec4f, a11: vec4f, w: vec2f) -> vec4f {
    return mix(mix(a00, a01, w.y), mix(a10, a11, w.y), w.x);
}

fn simulation_coords(pixel_coords: vec2f) -> vec2f {
    return vec2f(params.simulation_size) * (pixel_coords / vec2f(f32(params.pixel_size.x), f32(params.pixel_size.y)));
}

fn interpolate_s(coords: vec2f) -> vec4f {
    let upper_left = vec2u(coords + vec2f(0.5, 0.5));
    let mix_weight = coords + vec2f(0.5, 0.5) - vec2f(upper_left);

    let width = params.simulation_size.x + 2;
    let i = upper_left.y * width + upper_left.x;

    return mix2d_vec4f(s[i], s[i + width], s[i + 1], s[i + width + 1], mix_weight);
}

@vertex
fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    let positions = array<vec2f, 3>(vec2f(-1, 1), vec2f(3, 1), vec2f(-1, -3));
    return vec4f(positions[i], 0.0, 1.0);
}

@fragment
fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
    let coords = simulation_coords(position.xy);
    let dye = interpolate_s(coords);
    let max_color = max(dye.r, max(dye.g, dye.b));
    return vec4f(0.8510, 0.8157, 0.8157, 1.0) - dye / max(max_color, 1.0);
}
