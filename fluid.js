const W = 256;
const H = 128;

const DT = 0.001;

canvas = document.getElementById("fluidCanvas");
mouseDown = false;
let mousePosition = new Float32Array(2);

canvas.addEventListener("pointerdown", (event) => {
  mouseDown = true;
  mousePosition[0] = event.offsetX;
  mousePosition[1] = event.offsetY;
});

canvas.addEventListener("pointerup", () => {
  mouseDown = false;
});

canvas.addEventListener("pointermove", (event) => {
  mousePosition[0] = event.offsetX;
  mousePosition[1] = event.offsetY;
});

const shaders = `
@group(0) @binding(0)
var<uniform> mouseDown: bool;

@group(0) @binding(1)
var<uniform> mousePosition: vec2f;

@group(0) @binding(2)
var<storage, read_write> u0: array<vec2f>;

@group(0) @binding(3)
var<storage, read_write> u1: array<vec2f>;


@compute @workgroup_size(64)
fn update_velocity(
  @builtin(global_invocation_id) id: vec3u,
) {

}

@compute @workgroup_size(64)
fn update_dye() {

}

fn add_force(id: vec3u) {

}
`;

async function init() {
  if (!navigator.gpu) {
    throw Error("WebGPU not supported.");
  }

  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();

  const mousePositionBuffer = device.createBuffer({
    size: 8,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const uBufferSize = W * H * 3 * 4;
  let u = [];
  for (let i = 0; i < 2; ++i) {
    u[i] = device.createBuffer({
      size: uBufferSize,
      usage: GPUBufferUsage.STORAGE,
    });
  }

  return {
    device: device,
    mousePositionBuffer: mousePositionBuffer,
    mouseDownBuffer: mouseDownBuffer,
    u0Buffer: u0Buffer,
    u1Buffer: u1Buffer,
  };
}

function frame(state) {
  if (mouseDown) {
  }
}

let state = await init();
requestAnimationFrame((state) => frame);
