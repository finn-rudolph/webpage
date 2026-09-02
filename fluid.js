const SIMULATION_WIDTH = 1024;
const SIMULATION_HEIGHT = 512;

const WG_X = SIMULATION_WIDTH / 8;
const WG_Y = SIMULATION_HEIGHT / 8;

const SIMULATION_SPEED = 0.2;

const MOUSE_RADIUS = 0.05; // radius of the mouse force

const PRESSURE_JACOBI_ITERATIONS = 70;

let canvas = document.getElementById("fluidCanvas");
console.log(`canvas.width = ${canvas.width}`);
console.log(`canvas.height = ${canvas.height}`);
console.log(`jacobi it = ${PRESSURE_JACOBI_ITERATIONS}`);

let mouseParams = new ArrayBuffer(24);
let mouseParamsView = new DataView(mouseParams);

canvas.addEventListener("pointerdown", (event) => {
  mouseParamsView.setUint32(16, 1, true);
  mouseParamsView.setFloat32(0, event.offsetX / canvas.clientHeight, true); // this is correct (normalized coords)
  mouseParamsView.setFloat32(4, event.offsetY / canvas.clientHeight, true);
});

canvas.addEventListener("pointerup", () => {
  mouseParamsView.setUint32(16, 0, true);
});

// TODO: if the simulation feels laggy, store an array of movements and apply forces
// along the path.
canvas.addEventListener("pointermove", (event) => {
  mouseParamsView.setFloat32(0, event.offsetX / canvas.clientHeight, true);
  mouseParamsView.setFloat32(4, event.offsetY / canvas.clientHeight, true);
});

const canvasContext = canvas.getContext("webgpu");

// TODO: remove the no-cache
const computeCode = await fetch("compute.wgsl", { cache: "no-store" }).then(
  (r) => r.text(),
);
const renderCode = await fetch("render.wgsl", { cache: "no-store" }).then((r) =>
  r.text(),
);

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

  // --- params and mouse bind group ---

  const mouseBuffer = device.createBuffer({
    size: 24,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  let computeParamsBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const computeParams = new ArrayBuffer(16);
  const computeParamsView = new DataView(computeParams);
  computeParamsView.setUint32(0, SIMULATION_WIDTH, true);
  computeParamsView.setUint32(4, SIMULATION_HEIGHT, true);
  computeParamsView.setFloat32(8, MOUSE_RADIUS, true);

  device.queue.writeBuffer(computeParamsBuffer, 0, computeParams);

  const coordConstantsBuffer = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const coordConstants = new Float32Array(8);

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
      {
        binding: 2,
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
      {
        binding: 2,
        resource: { buffer: coordConstantsBuffer },
      },
    ],
  });

  // --- u bind group ---

  let uBuffer = [];
  for (let i = 0; i < 2; ++i) {
    uBuffer[i] = device.createBuffer({
      size: (SIMULATION_WIDTH + 2) * (SIMULATION_HEIGHT + 2) * 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
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

  let sBuffer = [];
  for (let i = 0; i < 2; ++i) {
    sBuffer[i] = device.createBuffer({
      size: (SIMULATION_WIDTH + 2) * (SIMULATION_HEIGHT + 2) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  let sBGLayout = device.createBindGroupLayout({
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

  let sBGEntries = [
    {
      binding: 0,
      resource: sBuffer[0],
    },
    {
      binding: 1,
      resource: sBuffer[1],
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
      size: (SIMULATION_WIDTH + 2) * (SIMULATION_HEIGHT + 2) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
  }

  let divBuffer = device.createBuffer({
    size: (SIMULATION_WIDTH + 2) * (SIMULATION_HEIGHT + 2) * 4,
    usage: GPUBufferUsage.STORAGE,
  });

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
      {
        binding: 2,
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
    { binding: 2, resource: divBuffer },
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

  // --- pipelines ---

  const computeModule = device.createShaderModule({ code: computeCode });

  const layout = device.createPipelineLayout({
    bindGroupLayouts: [paramsBGLayout, uBGLayout, sBGLayout, pBGLayout],
  });

  const pipeline = (entryPoint) => {
    return device.createComputePipeline({
      layout: layout,
      compute: {
        module: computeModule,
        entryPoint: entryPoint,
      },
    });
  };

  const addForcePipeline = pipeline("add_force");
  const transportVelocityPipeline = pipeline("transport_velocity");
  const divergencePipeline = pipeline("divergence");
  const jacobiPressurePipeline = pipeline("jacobi_pressure");
  const subPressureGradientPipeline = pipeline("sub_pressure_gradient");
  const addSourcePipeline = pipeline("add_source");
  const transportScalarFieldPipeline = pipeline("transport_scalar_field");

  // --- render stuff ---

  let renderParamsBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const renderParams = new ArrayBuffer(16);
  const renderParamsView = new DataView(renderParams);
  renderParamsView.setUint32(0, canvas.width, true);
  renderParamsView.setUint32(4, canvas.height, true);
  renderParamsView.setUint32(8, SIMULATION_WIDTH, true);
  renderParamsView.setUint32(12, SIMULATION_HEIGHT, true);
  device.queue.writeBuffer(renderParamsBuffer, 0, renderParams);

  let renderBindGroupEntries = [
    {
      binding: 0,
      resource: { buffer: sBuffer[0] },
    },
    {
      binding: 1,
      resource: { buffer: renderParamsBuffer },
    },
  ];

  let renderBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
        buffer: { type: "uniform" },
      },
    ],
  });

  const renderBindGroups = [];
  renderBindGroups[0] = device.createBindGroup({
    layout: renderBindGroupLayout,
    entries: renderBindGroupEntries,
  });

  renderBindGroupEntries[0].resource = sBuffer[1];
  renderBindGroups[1] = device.createBindGroup({
    layout: renderBindGroupLayout,
    entries: renderBindGroupEntries,
  });

  const renderPipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [renderBindGroupLayout],
  });
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
    layout: renderPipelineLayout,
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
      addForce: addForcePipeline,
      transportVelocity: transportVelocityPipeline,
      divergence: divergencePipeline,
      jacobiPressure: jacobiPressurePipeline,
      subPressureGradient: subPressureGradientPipeline,
      addSource: addSourcePipeline,
      transportScalarField: transportScalarFieldPipeline,
      render: renderPipeline,
      boundary: {
        velocity: {
          h: pipeline("velocity_boundary_h"),
          v: pipeline("velocity_boundary_v"),
        },
        pressure: {
          h: pipeline("pressure_boundary_h"),
          v: pipeline("pressure_boundary_v"),
        },
      },
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
    coordConstantsBuffer: coordConstantsBuffer,
    coordConstants: coordConstants,
    renderParamsBuffer: renderParamsBuffer,
    renderParams: renderParams,
    renderParamsView: renderParamsView,
    data: {
      u: uBuffer,
      s: sBuffer,
      p: pBuffer,
    },
  };
}

let last_time = null;
let last_mouse_pos = [0, 0];
let cnt = 0;

// TODO: if the timestep is too large, just reset the simulation.
function frame(time, state) {
  const dt = last_time === null ? 0 : time - last_time;
  last_time = time;

  cnt++;

  // console.log((mouseParamsView.getFloat32(0, true) - last_mouse_pos[0]) / dt);
  mouseParamsView.setFloat32(
    8,
    (mouseParamsView.getFloat32(0, true) - last_mouse_pos[0]) / dt,
    true,
  );
  mouseParamsView.setFloat32(
    12,
    (mouseParamsView.getFloat32(4, true) - last_mouse_pos[1]) / dt,
    true,
  );
  last_mouse_pos = [
    mouseParamsView.getFloat32(0, true),
    mouseParamsView.getFloat32(4, true),
  ];
  state.device.queue.writeBuffer(state.mouseBuffer, 0, mouseParams);

  const dpr = window.devicePixelRatio;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);

  const commandEncoder = state.device.createCommandEncoder();

  // --- compute part ---

  state.computeParamsView.setFloat32(12, dt * SIMULATION_SPEED, true);
  state.device.queue.writeBuffer(
    state.computeParamsBuffer,
    0,
    state.computeParams,
  );

  const aspect_ratio = canvas.clientWidth / canvas.clientHeight;
  const r_delta_x = SIMULATION_WIDTH / aspect_ratio;
  const r_delta_y = SIMULATION_HEIGHT;
  const sq_delta_x = 1 / (r_delta_x * r_delta_x);
  const sq_delta_y = 1 / (r_delta_y * r_delta_y);
  state.coordConstants[0] = aspect_ratio;
  state.coordConstants[1] =
    1 / (2 * (r_delta_x * r_delta_x + r_delta_y * r_delta_y));
  state.coordConstants[2] = sq_delta_y / (2 * (sq_delta_x + sq_delta_y));
  state.coordConstants[3] = sq_delta_x / (2 * (sq_delta_x + sq_delta_y));
  state.coordConstants[4] = r_delta_x;
  state.coordConstants[5] = r_delta_y;
  state.coordConstants[6] = 0.5 * r_delta_x;
  state.coordConstants[7] = 0.5 * r_delta_y;
  state.device.queue.writeBuffer(
    state.coordConstantsBuffer,
    0,
    state.coordConstants,
  );

  const computePassEncoder = commandEncoder.beginComputePass();
  computePassEncoder.setBindGroup(0, state.bindGroups.params);
  computePassEncoder.setBindGroup(1, state.bindGroups.u[state.parity.u]);
  computePassEncoder.setBindGroup(2, state.bindGroups.s[state.parity.s]);
  computePassEncoder.setBindGroup(3, state.bindGroups.p[state.parity.p]);

  const set_boundary = (qty_name) => {
    computePassEncoder.setPipeline(state.pipelines.boundary[qty_name].h);
    computePassEncoder.dispatchWorkgroups(SIMULATION_WIDTH / 64);
    computePassEncoder.setPipeline(state.pipelines.boundary[qty_name].v);
    computePassEncoder.dispatchWorkgroups(SIMULATION_HEIGHT / 64);
  };

  computePassEncoder.setPipeline(state.pipelines.addForce);
  computePassEncoder.dispatchWorkgroups(WG_X, WG_Y);

  set_boundary("velocity");
  computePassEncoder.setPipeline(state.pipelines.transportVelocity);
  computePassEncoder.dispatchWorkgroups(WG_X, WG_Y);
  state.parity.u ^= 1;
  computePassEncoder.setBindGroup(1, state.bindGroups.u[state.parity.u]);

  set_boundary("velocity");
  computePassEncoder.setPipeline(state.pipelines.divergence);
  computePassEncoder.dispatchWorkgroups(WG_X, WG_Y);

  // We "warm-start" from the previous pressure. One could consider doing more iterations
  // if a force is currently active.
  for (let i = 0; i < PRESSURE_JACOBI_ITERATIONS; ++i) {
    set_boundary("pressure");
    computePassEncoder.setPipeline(state.pipelines.jacobiPressure);
    computePassEncoder.dispatchWorkgroups(WG_X, WG_Y);
    state.parity.p ^= 1;
    computePassEncoder.setBindGroup(3, state.bindGroups.p[state.parity.p]);
  }

  set_boundary("pressure");
  computePassEncoder.setPipeline(state.pipelines.subPressureGradient);
  computePassEncoder.dispatchWorkgroups(WG_X, WG_Y);

  computePassEncoder.setPipeline(state.pipelines.addSource);
  computePassEncoder.dispatchWorkgroups(WG_X, WG_Y);

  computePassEncoder.setPipeline(state.pipelines.transportScalarField);
  computePassEncoder.dispatchWorkgroups(WG_X, WG_Y);
  state.parity.s ^= 1;
  computePassEncoder.setBindGroup(2, state.bindGroups.s[state.parity.s]);

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

  if (cnt % 41 == 0) {
    // debug_buffer(
    //   state.data.u[state.parity.u],
    //   (SIMULATION_WIDTH + 2) * (SIMULATION_HEIGHT + 2) * 8,
    //   state.device,
    // );
  }

  requestAnimationFrame((time) => frame(time, state));
}

async function debug_buffer(input, size, device) {
  let buffer = device.createBuffer({
    size: size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();

  encoder.copyBufferToBuffer(input, buffer);

  device.queue.submit([encoder.finish()]);

  await buffer.mapAsync(GPUMapMode.READ, 0);

  const copyArrayBuffer = buffer.getMappedRange(0, size);
  const out = copyArrayBuffer.slice();
  buffer.unmap();
  let arr = new Float32Array(out);
  // console.log(arr);
  console.log(arr.every((x) => x === 0));
  console.log(
    arr[SIMULATION_HEIGHT * SIMULATION_WIDTH],
    arr[SIMULATION_HEIGHT * SIMULATION_WIDTH + 1],
  );
}

async function debug_texture(input, width, height, device) {
  let buffer = device.createBuffer({
    size: width * height * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();

  encoder.copyTextureToBuffer(
    { texture: input },
    { buffer: buffer, bytesPerRow: width * 4 },
    { width, height },
  );

  device.queue.submit([encoder.finish()]);

  await buffer.mapAsync(GPUMapMode.READ, 0);

  const copyArrayBuffer = buffer.getMappedRange(0, width * height * 4);
  const out = copyArrayBuffer.slice();
  buffer.unmap();
  let arr = new Float32Array(out);
  console.log(arr);
}

let state = await init();
console.log("initialization finished");

requestAnimationFrame((time) => frame(time, state));
