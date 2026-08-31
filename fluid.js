const SIMULATION_WIDTH = 1024;
const SIMULATION_HEIGHT = 512;

const WG_X = SIMULATION_WIDTH / 8;
const WG_Y = SIMULATION_HEIGHT / 8;

const SIMULATION_SPEED = 0.1;

const MOUSE_RADIUS = 0.05; // radius of the mouse force

const PRESSURE_JACOBI_ITERATIONS = 20;
const VISCOSITY_JACOBI_ITERATIONS = 20;

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

  // --- compute stuff ---

  const computeModule = device.createShaderModule({ code: computeCode });

  const addSourcePipeline = device.createComputePipeline({
    layout: "auto",
    compute: {
      module: computeModule,
      entryPoint: "add_source",
    },
  });

  const transportScalarFieldPipeline = device.createComputePipeline({
    layout: "auto",
    compute: {
      module: computeModule,
      entryPoint: "transport_scalar_field",
    },
  });

  const jacobiPressurePipeline = device.createComputePipeline({
    layout: "auto",
    compute: {
      module: computeModule,
      entryPoint: "jacobi_pressure",
    },
  });

  // --- params and mouse bind group ---

  const mouseBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  let computeParamsBuffer = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const computeParams = new ArrayBuffer(32);
  const computeParamsView = new DataView(computeParams);
  computeParamsView.setUint32(0, SIMULATION_WIDTH, true);
  computeParamsView.setUint32(4, SIMULATION_HEIGHT, true);
  computeParamsView.setFloat32(8, MOUSE_RADIUS, true);
  computeParamsView.setUint32(20, 12, true);
  computeParamsView.setFloat32(24, 1.0 / (2 * 12), true);

  device.queue.writeBuffer(computeParamsBuffer, 0, computeParams);

  let paramsBGLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" },
      },
    ],
  });

  let paramsBindGroup = device.createBindGroup({
    layout: paramsBGLayout,
    entries: [
      {
        binding: 0,
        resource: { buffer: mouseBuffer },
      },
      {
        binding: 1,
        resource: { buffer: computeParamsBuffer },
      },
    ],
  });

  // --- u bind group ---

  let uBuffer = [];
  for (let i = 0; i < 2; ++i) {
    uBuffer[i] = device.createBuffer({
      size: SIMULATION_WIDTH * SIMULATION_HEIGHT * 8,
      usage: GPUBufferUsage.STORAGE,
    });
  }

  let uBGLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" },
      },
    ],
  });

  let uBGEntries = [
    {
      binding: 0,
      resource: uBuffer[0],
    },
    {
      binding: 1,
      resource: uBuffer[1],
    },
  ];

  let uBindGroups = [];
  uBindGroups[0] = device.createBindGroup({
    layout: uBGLayout,
    entries: uBGEntries,
  });
  uBGEntries[0].binding = 1;
  uBGEntries[1].binding = 0;
  uBindGroups[1] = device.createBindGroup({
    layout: uBGLayout,
    entries: uBGEntries,
  });

  // --- s bind group ---

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

  let sBGLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: "read-write",
          format: "r32float",
          viewDimension: "2d",
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: {
          access: "read-write",
          format: "r32float",
          viewDimension: "2d",
        },
      },
    ],
  });

  let sBGEntries = [
    {
      binding: 0,
      resource: sTexture[0],
    },
    {
      binding: 1,
      resource: sTexture[1],
    },
  ];

  let sBindGroups = [];
  sBindGroups[0] = device.createBindGroup({
    layout: sBGLayout,
    entries: sBGEntries,
  });
  sBGEntries[0].binding = 1;
  sBGEntries[1].binding = 0;
  sBindGroups[1] = device.createBindGroup({
    layout: sBGLayout,
    entries: sBGEntries,
  });

  // --- p bind groups ---

  let pBuffer = [];
  for (let i = 0; i < 2; ++i) {
    pBuffer[i] = device.createBuffer({
      size: SIMULATION_WIDTH * SIMULATION_HEIGHT * 4,
      usage: GPUBufferUsage.STORAGE,
    });
  }

  let pBGLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" },
      },
    ],
  });

  let pBGEntries = [
    {
      binding: 0,
      resource: pBuffer[0],
    },
    {
      binding: 1,
      resource: pBuffer[1],
    },
  ];

  let pBindGroups = [];
  pBindGroups[0] = device.createBindGroup({
    layout: pBGLayout,
    entries: pBGEntries,
  });
  pBGEntries[0].binding = 1;
  pBGEntries[1].binding = 0;
  pBindGroups[1] = device.createBindGroup({
    layout: pBGLayout,
    entries: pBGEntries,
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

  const renderBindGroups = [];
  renderBindGroups[0] = device.createBindGroup({
    layout: renderPipeline.getBindGroupLayout(0),
    entries: renderBindGroupEntries,
  });

  renderBindGroupEntries[0].resource = sTexture[1];
  renderBindGroups[1] = device.createBindGroup({
    layout: renderPipeline.getBindGroupLayout(0),
    entries: renderBindGroupEntries,
  });

  return {
    device: device,
    bindGroups: {
      params: paramsBindGroup,
      u: uBindGroups,
      s: sBindGroups,
      p: pBindGroups,
      render: renderBindGroups,
    },
    pipelines: {
      addSource: addSourcePipeline,
      transportScalarField: transportScalarFieldPipeline,
      jacobiPressure: jacobiPressurePipeline,
      render: renderPipeline,
    },
    parity: {
      u: 0, // whether the current data lives in u0 or u1
      s: 0,
      p: 0,
    },
    mouseBuffer: mouseBuffer,
    computeParamsBuffer: computeParamsBuffer,
    computeParams: computeParams,
    computeParamsView: computeParamsView,
    renderParamsBuffer: renderParamsBuffer,
    renderParams: renderParams,
    renderParamsView: renderParamsView,
  };
}

let last_time = null;

function frame(time, state) {
  const dt = last_time === null ? 0 : time - last_time;
  last_time = time;

  const commandEncoder = state.device.createCommandEncoder();

  // --- compute part ---

  state.device.queue.writeBuffer(state.mouseBuffer, 0, mouseParams);

  state.computeParamsView.setFloat32(12, dt * SIMULATION_SPEED, true);
  state.computeParamsView.setFloat32(16, canvas.width / canvas.height, true);
  state.device.queue.writeBuffer(
    state.computeParamsBuffer,
    0,
    state.computeParams,
  );

  const computePassEncoder = commandEncoder.beginComputePass();
  computePassEncoder.setBindGroup(0, state.bindGroups.params);
  computePassEncoder.setBindGroup(1, state.bindGroups.u[state.parity.u]);

  // computePassEncoder.setPipeline(state.pipelines.addForce);
  // computePassEncoder.dispatchWorkgroups(WG_X, WG_Y);

  computePassEncoder.setPipeline(state.pipelines.transportScalarField);
  computePassEncoder.dispatchWorkgroups(WG_X, WG_Y);
  state.parity.u ^= 1;
  computePassEncoder.setBindGroup(1, state.bindGroups.u[state.parity.u]);

  // We "warm-start" from the previous pressure. One could consider doing more iterations
  // if a force is currently active.
  for (let i = 0; i < PRESSURE_JACOBI_ITERATIONS; ++i) {
    computePassEncoder.setPipeline(state.pipelines.jacobiPressure);
    computePassEncoder.setBindGroup(3, state.bindGroups.p[state.parity.p]);
    state.parity.p ^= 1;
    computePassEncoder.dispatchWorkgroups(WG_X, WG_Y);
  }

  computePassEncoder.setPipeline(state.pipelines.addSource);
  computePassEncoder.setBindGroup(2, state.bindGroups.s[state.parity.s]);
  computePassEncoder.dispatchWorkgroups(WG_X, WG_Y);

  computePassEncoder.end();

  // --- render part ---

  state.renderParamsView.setUint32(0, canvas.width, true);
  state.renderParamsView.setUint32(4, canvas.height, true);
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
  renderPassEncoder.setPipeline(state.pipelines.render);
  renderPassEncoder.setBindGroup(0, state.bindGroups.render[state.parity.s]);
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
