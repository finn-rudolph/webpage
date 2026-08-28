const WIDTH = 256;
const HEIGHT = 256;

const DT = 0.001;

const RADIUS = 10.0; // radius of the mouse force

let canvas = document.getElementById("fluidCanvas");
let mouseDown = false;
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

const shaders = await fetch("shaders.wgsl").then((r) => r.text());

async function init() {
  if (!navigator.gpu) {
    throw Error("WebGPU not supported.");
  }

  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();

  const mouseBuffer = device.createBuffer({
    size: 12,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const U_BUFFER_SIZE = WIDTH * HEIGHT * 3 * 4;
  let uBuffer = [];
  for (let i = 0; i < 2; ++i) {
    uBuffer[i] = device.createBuffer({
      size: U_BUFFER_SIZE,
      usage: GPUBufferUsage.STORAGE,
    });
  }

  const S_BUFFER_SIZE = WIDTH * HEIGHT * 4;
  let sBuffer = [];
  for (let i = 0; i < 2; ++i) {
    sBuffer[i] = device.createBuffer({
      size: S_BUFFER_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
  }

  let paramsBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const params = new ArrayBuffer(16);
  const paramsView = new DataView(params);
  paramsView.setUint32(0, WIDTH, true);
  paramsView.setUint32(4, HEIGHT, true);
  paramsView.setFloat32(8, RADIUS, true);
  paramsView.setFloat32(12, DT, true);
  device.queue.writeBuffer(paramsBuffer, 0, params);

  const testBuffer = device.createBuffer({
    size: S_BUFFER_SIZE,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  let bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" },
      },
      {
        binding: 5,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" },
      },
    ],
  });

  // We create two bind groups, one for even and one for odd iterations.
  // The velocity and scalar field arrays are swapped after each iteration,
  // so that the old velocity is in u0, and the new velocity is written in u1.
  let bindGroupEntries = [
    {
      binding: 0,
      resource: { buffer: mouseBuffer },
    },
    {
      binding: 1,
      resource: { buffer: uBuffer[0] },
    },
    {
      binding: 2,
      resource: { buffer: uBuffer[1] },
    },
    {
      binding: 3,
      resource: { buffer: sBuffer[0] },
    },
    {
      binding: 4,
      resource: { buffer: sBuffer[1] },
    },
    {
      binding: 5,
      resource: { buffer: paramsBuffer },
    },
  ];

  console.log(bindGroupEntries);

  let bindGroup = [];
  bindGroup[0] = device.createBindGroup({
    layout: bindGroupLayout,
    entries: bindGroupEntries,
  });

  bindGroupEntries[1].binding = 2;
  bindGroupEntries[2].binding = 1;
  bindGroupEntries[3].binding = 4;
  bindGroupEntries[4].binding = 3;

  bindGroup[1] = device.createBindGroup({
    layout: bindGroupLayout,
    entries: bindGroupEntries,
  });

  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    }),
    compute: {
      module: device.createShaderModule({ code: shaders }),
      entryPoint: "update_scalar_field",
    },
  });

  const commandEncoder = device.createCommandEncoder();
  const passEncoder = commandEncoder.beginComputePass();

  passEncoder.setPipeline(pipeline);
  passEncoder.setBindGroup(0, bindGroup[0]);
  passEncoder.dispatchWorkgroups(32, 32);
  passEncoder.end();

  commandEncoder.copyBufferToBuffer(
    sBuffer[1],
    0, // Source offset
    testBuffer,
    0, // Destination offset
    S_BUFFER_SIZE, // Length in bytes
  );

  device.queue.submit([commandEncoder.finish()]);

  await testBuffer.mapAsync(GPUMapMode.READ, 0, S_BUFFER_SIZE);

  const copyArrayBuffer = testBuffer.getMappedRange(0, S_BUFFER_SIZE);
  const data = copyArrayBuffer.slice();
  testBuffer.unmap();
  console.log(new Float32Array(data));

  return {
    device: device,
    bindGroup: bindGroup,
    paramsBuffer: paramsBuffer,
    mouseBuffer: mouseBuffer,
    uBuffer: uBuffer,
    sBuffer: sBuffer,
  };
}

function frame(state) {}

let state = await init();
// requestAnimationFrame((state) => frame);
