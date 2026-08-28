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

const canvasContext = canvas.getContext("webgpu");

const computeCode = await fetch("compute.wgsl").then((r) => r.text());
const renderCode = await fetch("render.wgsl").then((r) => r.text());

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

  let sTexture = [];
  for (let i = 0; i < 2; ++i) {
    sTexture[i] = device.createTexture({
      size: [WIDTH, HEIGHT],
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
  }
  const sView = [sTexture[0].createView(), sTexture[1].createView()];

  // --- compute stuff ---

  let computeParamsBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const computeParams = new ArrayBuffer(16);
  const computeParamsView = new DataView(computeParams);
  computeParamsView.setUint32(0, WIDTH, true);
  computeParamsView.setUint32(4, HEIGHT, true);
  computeParamsView.setFloat32(8, RADIUS, true);
  computeParamsView.setFloat32(12, DT, true);
  device.queue.writeBuffer(computeParamsBuffer, 0, computeParams);

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
  let computeBindGroupEntries = [
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
      resource: { buffer: computeParamsBuffer },
    },
  ];

  let computeBindGroup = [];
  computeBindGroup[0] = device.createBindGroup({
    layout: bindGroupLayout,
    entries: computeBindGroupEntries,
  });

  computeBindGroupEntries[1].binding = 2;
  computeBindGroupEntries[2].binding = 1;
  computeBindGroupEntries[3].binding = 4;
  computeBindGroupEntries[4].binding = 3;

  computeBindGroup[1] = device.createBindGroup({
    layout: bindGroupLayout,
    entries: computeBindGroupEntries,
  });

  const computePipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    }),
    compute: {
      module: device.createShaderModule({ code: computeCode }),
      entryPoint: "main",
    },
  });

  // --- render stuff ---

  const scalarFieldSampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });

  const renderModule = device.createShaderModule({ code: renderCode });
  const renderPipeline = device.createRenderPipeline({
    vertex: {
      module: renderModule,
      entryPoint: "vertex_main",
    },
    fragment: {
      module: renderModule,
      entryPoint: "fragment_main",
      targets: [
        {
          format: navigator.gpu.getPreferredCanvasFormat(),
        },
      ],
    },
    layout: "auto",
  });

  let renderBindGroupEntries = [
    {
      binding: 0,
      resource: sTexture[1],
    },
    {
      binding: 1,
      resource: scalarFieldSampler,
    },
    {
      binding: 2,
      resource: { buffer: renderParamsBuffer },
    },
  ];

  const renderBindGroup = [];
  renderBindGroup[0] = device.createBindGroup({
    layout: renderPipeline.getBindGroupLayout(0),
    entries: renderBindGroupEntries,
  });

  renderBindGroupEntries[0].resource = sTexture[0];
  renderBindGroup[1] = device.createBindGroup({
    layout: renderPipeline.getBindGroupLayout(0),
    entries: renderBindGroupEntries,
  });

  return {
    device: device,
    bindGroup: computeBindGroup,
    paramsBuffer: computeParamsBuffer,
    mouseBuffer: mouseBuffer,
    uBuffer: uBuffer,
    sTexture: sTexture,
    bufferParity: 0,
  };
}

function frame(state) {
  const commandEncoder = device.createCommandEncoder();

  // --- compute part ---

  const computePassEncoder = commandEncoder.beginComputePass();

  computePassEncoder.setPipeline(state.computePipeline);
  computePassEncoder.setBindGroup(0, bindGroup[state.bufferParity]);
  computePassEncoder.dispatchWorkgroups(32, 32);
  computePassEncoder.end();

  // --- render part ---

  // const msaaTexture = device.createTexture({
  //   size: {
  //     width: canvas.width,
  //     height: canvas.height,
  //   },
  //   format: navigator.gpu.getPreferredCanvasFormat(),
  //   sampleCount: 4,
  //   usage: GPUTextureUsage.RENDER_ATTACHMENT,
  // });

  const renderPassDescriptor = {
    colorAttachments: [
      {
        clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
        loadOp: "clear",
        storeOp: "store",
        view: msaaTexture.createView(),
        resolveTarget: context.getCurrentTexture().createView(),
      },
    ],
  };

  const renderPassEncoder =
    commandEncoder.beginRenderPass(renderPassDescriptor);
  renderPassEncoder.setPipeline(pipelineDescriptor);
  renderPassEncoder.draw(3);
  renderPassEncoder.end();

  device.queue.submit([commandEncoder.finish()]);

  state.bufferParity = 1 - state.bufferParity;
  requestAnimationFrame((state) => frame);
}

async function debug() {
  commandEncoder.copyBufferToBuffer(
    sBuffer[1],
    0, // Source offset
    testBuffer,
    0, // Destination offset
    S_BUFFER_SIZE, // Length in bytes
  );

  await testBuffer.mapAsync(GPUMapMode.READ, 0, S_BUFFER_SIZE);

  const copyArrayBuffer = testBuffer.getMappedRange(0, S_BUFFER_SIZE);
  const data = copyArrayBuffer.slice();
  testBuffer.unmap();
  console.log(new Float32Array(data));
}

let state = await init();
// requestAnimationFrame((state) => frame);
