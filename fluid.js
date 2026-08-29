const SIMULATION_WIDTH = 1024;
const SIMULATION_HEIGHT = 512;

const WG_X = SIMULATION_WIDTH / 8;
const WG_Y = SIMULATION_HEIGHT / 8;

const SIMULATION_SPEED = 0.1;

const MOUSE_RADIUS = 0.05; // radius of the mouse force

let canvas = document.getElementById("fluidCanvas");
console.log(`canvas.width = ${canvas.width}`);
console.log(`canvas.height = ${canvas.height}`);

let mouseParams = new ArrayBuffer(16);
let mouseParamsView = new DataView(mouseParams);

canvas.addEventListener("pointerdown", (event) => {
  mouseParamsView.setUint32(8, 1, true);
  mouseParamsView.setFloat32(0, event.offsetX / canvas.clientHeight, true); // this is correct (normalized coords)
  mouseParamsView.setFloat32(4, event.offsetY / canvas.clientHeight, true);
});

canvas.addEventListener("pointerup", () => {
  mouseParamsView.setUint32(8, 0, true);
});

canvas.addEventListener("pointermove", (event) => {
  mouseParamsView.setFloat32(0, event.offsetX / canvas.clientHeight, true);
  mouseParamsView.setFloat32(4, event.offsetY / canvas.clientHeight, true);
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

  canvasContext.configure({
    device,
    format: navigator.gpu.getPreferredCanvasFormat(),
    alphaMode: "premultiplied",
  });

  const mouseBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  let uBuffer = [];
  for (let i = 0; i < 2; ++i) {
    uBuffer[i] = device.createBuffer({
      size: SIMULATION_WIDTH * SIMULATION_HEIGHT * 8,
      usage: GPUBufferUsage.STORAGE,
    });
  }

  let sTexture = [];
  for (let i = 0; i < 2; ++i) {
    sTexture[i] = device.createTexture({
      size: [SIMULATION_WIDTH, SIMULATION_HEIGHT],
      format: "r32float",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
  }

  // --- compute stuff ---

  let computeParamsBuffer = device.createBuffer({
    size: 24,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const computeParams = new ArrayBuffer(24);
  const computeParamsView = new DataView(computeParams);
  computeParamsView.setUint32(0, SIMULATION_WIDTH, true);
  computeParamsView.setUint32(4, SIMULATION_HEIGHT, true);
  computeParamsView.setFloat32(8, MOUSE_RADIUS, true);
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
        buffer: { type: "storage" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: "read-write",
          format: "r32float",
          viewDimension: "2d",
        },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: "read-write",
          format: "r32float",
          viewDimension: "2d",
        },
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
      resource: uBuffer[0],
    },
    {
      binding: 2,
      resource: uBuffer[1],
    },
    {
      binding: 3,
      resource: sTexture[0],
    },
    {
      binding: 4,
      resource: sTexture[1],
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

  const computePipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });
  const computeModule = device.createShaderModule({ code: computeCode });

  const addSourcePipeline = device.createComputePipeline({
    layout: computePipelineLayout,
    compute: {
      module: computeModule,
      entryPoint: "add_source",
    },
  });

  const transportScalarFieldPipeline = device.createComputePipeline({
    layout: computePipelineLayout,
    compute: {
      module: computeModule,
      entryPoint: "transport_scalar_field",
    },
  });

  // --- render stuff ---

  const renderModule = device.createShaderModule({ code: renderCode });
  const renderPipeline = device.createRenderPipeline({
    vertex: {
      module: renderModule,
      entryPoint: "vertex",
    },
    fragment: {
      module: renderModule,
      entryPoint: "fragment",
      targets: [
        {
          format: navigator.gpu.getPreferredCanvasFormat(),
        },
      ],
    },
    layout: "auto",
  });

  let renderParamsBuffer = device.createBuffer({
    size: 8,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const renderParams = new ArrayBuffer(8);
  const renderParamsView = new DataView(renderParams);
  renderParamsView.setUint32(0, canvas.width, true);
  renderParamsView.setUint32(4, canvas.height, true);
  device.queue.writeBuffer(renderParamsBuffer, 0, renderParams);

  let renderBindGroupEntries = [
    {
      binding: 0,
      resource: sTexture[0],
    },
    {
      binding: 1,
      resource: { buffer: renderParamsBuffer },
    },
  ];

  const renderBindGroup = [];
  renderBindGroup[0] = device.createBindGroup({
    layout: renderPipeline.getBindGroupLayout(0),
    entries: renderBindGroupEntries,
  });

  renderBindGroupEntries[0].resource = sTexture[1];
  renderBindGroup[1] = device.createBindGroup({
    layout: renderPipeline.getBindGroupLayout(0),
    entries: renderBindGroupEntries,
  });

  return {
    device: device,
    mouseBuffer: mouseBuffer,
    computeBindGroup: computeBindGroup,
    computeParamsBuffer: computeParamsBuffer,
    computeParams: computeParams,
    renderParamsBuffer: renderParamsBuffer,
    renderParams: renderParams,
    renderBindGroup: renderBindGroup,
    renderPipeline: renderPipeline,
    bindGroupParity: 0,
    pipelines: {
      addSource: addSourcePipeline,
      transportScalarField: transportScalarFieldPipeline,
      render: renderPipeline,
    },
  };
}

let last_time = null;

function frame(time, state) {
  const dt = last_time === null ? 0 : time - last_time;
  last_time = time;

  const commandEncoder = state.device.createCommandEncoder();

  // --- compute part ---

  state.device.queue.writeBuffer(state.mouseBuffer, 0, mouseParams);

  const computeParamsView = new DataView(state.computeParams);
  computeParamsView.setFloat32(12, dt * SIMULATION_SPEED, true);
  computeParamsView.setFloat32(16, canvas.width / canvas.height, true);
  state.device.queue.writeBuffer(
    state.computeParamsBuffer,
    0,
    state.computeParams,
  );

  const computePassEncoder = commandEncoder.beginComputePass();

  computePassEncoder.setPipeline(state.pipelines.addSource);
  computePassEncoder.setBindGroup(
    0,
    state.computeBindGroup[state.bindGroupParity],
  );
  computePassEncoder.dispatchWorkgroups(WG_X, WG_Y);

  computePassEncoder.setPipeline(state.pipelines.transportScalarField);
  computePassEncoder.dispatchWorkgroups(WG_X, WG_Y);
  state.bindGroupParity = 1 - state.bindGroupParity;

  computePassEncoder.end();

  // --- render part ---

  const renderParamsView = new DataView(state.renderParams);
  renderParamsView.setUint32(0, canvas.width, true);
  renderParamsView.setUint32(4, canvas.height, true);
  state.device.queue.writeBuffer(
    state.renderParamsBuffer,
    0,
    state.renderParams,
  );

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
        view: canvasContext.getCurrentTexture().createView(),
      },
    ],
  };

  const renderPassEncoder =
    commandEncoder.beginRenderPass(renderPassDescriptor);
  renderPassEncoder.setPipeline(state.renderPipeline);
  renderPassEncoder.setBindGroup(
    0,
    state.renderBindGroup[state.bindGroupParity],
  );
  renderPassEncoder.draw(3);
  renderPassEncoder.end();

  state.device.queue.submit([commandEncoder.finish()]);
  requestAnimationFrame((time) => frame(time, state));
}

async function debug_buffer(buffer, length, device) {
  // encoder.copyBufferToBuffer(texture, 0, buffer, 0, S_BUFFER_SIZE);
}

async function debug_texture(texture, width, height, device) {
  let buffer = device.createBuffer({
    size: width * height * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();

  encoder.copyTextureToBuffer(
    { texture: texture },
    { buffer: buffer, bytesPerRow: width * 4 },
    { width, height },
  );

  device.queue.submit([encoder.finish()]);

  await buffer.mapAsync(GPUMapMode.READ, 0);

  const copyArrayBuffer = buffer.getMappedRange(0, width * height * 4);
  const out = copyArrayBuffer.slice();
  buffer.unmap();
  let arr = new Float32Array(out);
  console.log(arr.every((x) => x === 0));
}

let state = await init();
console.log("initialization finished");

requestAnimationFrame((time) => frame(time, state));
