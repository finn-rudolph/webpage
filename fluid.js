const simulation_width = 512;
const simulation_height = 256;

const num_workgroups = [simulation_width / 8, simulation_height / 8];
const jacobi_iterations = 60;

const mouse_radius = 0.05; // radius of the mouse force

const viscosity = 0.00001;
const dissipation_rate = 0.0005;
const time_scale = 0.2; // the physical time step is `time_scale` * [browser time step in ms]

let canvas = document.getElementById("fluidCanvas");
console.log(`canvas.width = ${canvas.width}`);
console.log(`canvas.height = ${canvas.height}`);

let mouseParams = new ArrayBuffer(48);
let mouseIsDown = false;
let mouseView = new DataView(mouseParams);
let colorVectors = {
  r: { x: 1.0, y: 0.0 },
  g: { x: -0.5, y: 0.5 * Math.sqrt(3) },
  b: { x: -0.5, y: -0.5 * Math.sqrt(3) },
};

// TODO; handle mouse exiting the canvas.
canvas.addEventListener("pointerdown", (event) => {
  mouseIsDown = true;
  mouseView.setFloat32(0, event.offsetX / canvas.clientHeight, true); // this is correct (normalized coords)
  mouseView.setFloat32(4, event.offsetY / canvas.clientHeight, true);

  const theta = Math.random() * 2 * Math.PI;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  colorVectors = {
    r: { x: cos, y: sin },
    g: {
      x: 0.5 * (-cos - Math.sqrt(3) * sin),
      y: 0.5 * (-sin + Math.sqrt(3) * cos),
    },
    b: {
      x: 0.5 * (-cos + Math.sqrt(3) * sin),
      y: 0.5 * (-sin - Math.sqrt(3) * cos),
    },
  };
});

canvas.addEventListener("pointerup", () => {
  mouseIsDown = false;
});

// TODO: if the simulation feels laggy, store an array of movements and apply forces
// along the path.
canvas.addEventListener("pointermove", (event) => {
  mouseView.setFloat32(0, event.offsetX / canvas.clientHeight, true);
  mouseView.setFloat32(4, event.offsetY / canvas.clientHeight, true);
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
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  let computeConstBuffer = device.createBuffer({
    size: 96,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const computeConst = new ArrayBuffer(96);
  const computeConstView = new DataView(computeConst);
  computeConstView.setUint32(0, simulation_width, true);
  computeConstView.setUint32(4, simulation_height, true);
  computeConstView.setUint32(8, simulation_width + 2, true);
  computeConstView.setUint32(12, simulation_height + 2, true);
  computeConstView.setFloat32(68, viscosity, true);
  computeConstView.setFloat32(72, dissipation_rate, true);

  device.queue.writeBuffer(computeConstBuffer, 0, computeConst);

  let constLayout = device.createBindGroupLayout({
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

  let constBindGroup = device.createBindGroup({
    layout: constLayout,
    entries: [
      {
        binding: 0,
        resource: { buffer: mouseBuffer },
      },
      {
        binding: 1,
        resource: { buffer: computeConstBuffer },
      },
    ],
  });

  // --- u bind group ---

  let uBuffer = [];
  for (let i = 0; i < 2; ++i) {
    uBuffer[i] = device.createBuffer({
      size: (simulation_width + 2) * (simulation_height + 2) * 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
  }

  let uLayout = device.createBindGroupLayout({
    entries: [0, 1].map((i) => ({
      binding: i,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "storage" },
    })),
  });
  let uEntries = [0, 1].map((i) => ({ binding: i, resource: uBuffer[i] }));

  let uBindGroups = [];
  uBindGroups[0] = device.createBindGroup({
    layout: uLayout,
    entries: uEntries,
  });
  uEntries[0].binding = 1;
  uEntries[1].binding = 0;
  uBindGroups[1] = device.createBindGroup({
    layout: uLayout,
    entries: uEntries,
  });

  // --- s bind group ---

  let sBuffer = [];
  for (let i = 0; i < 2; ++i) {
    sBuffer[i] = device.createBuffer({
      size: (simulation_width + 2) * (simulation_height + 2) * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
  }

  let sLayout = device.createBindGroupLayout({
    entries: [0, 1].map((i) => ({
      binding: i,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "storage" },
    })),
  });

  let sEntries = [0, 1].map((i) => ({ binding: i, resource: sBuffer[i] }));

  let sBindGroups = [];
  sBindGroups[0] = device.createBindGroup({
    layout: sLayout,
    entries: sEntries,
  });
  sEntries[0].binding = 1;
  sEntries[1].binding = 0;
  sBindGroups[1] = device.createBindGroup({
    layout: sLayout,
    entries: sEntries,
  });

  // --- p bind groups ---

  let pBuffer = [];
  for (let i = 0; i < 2; ++i) {
    pBuffer[i] = device.createBuffer({
      size: (simulation_width + 2) * (simulation_height + 2) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
  }

  let divergenceBuffer = device.createBuffer({
    size: (simulation_width + 2) * (simulation_height + 2) * 4,
    usage: GPUBufferUsage.STORAGE,
  });

  let pLayout = device.createBindGroupLayout({
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

  let pEntries = [
    {
      binding: 0,
      resource: pBuffer[0],
    },
    {
      binding: 1,
      resource: pBuffer[1],
    },
    { binding: 2, resource: divergenceBuffer },
  ];

  let pBindGroups = [];
  pBindGroups[0] = device.createBindGroup({
    layout: pLayout,
    entries: pEntries,
  });
  pEntries[0].binding = 1;
  pEntries[1].binding = 0;
  pBindGroups[1] = device.createBindGroup({
    layout: pLayout,
    entries: pEntries,
  });

  // --- pipelines ---

  const computeModule = device.createShaderModule({ code: computeCode });

  const layout = device.createPipelineLayout({
    bindGroupLayouts: [constLayout, uLayout, sLayout, pLayout],
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
  const jacobiDiffusePipeline = pipeline("jacobi_diffuse");
  const addSourcePipeline = pipeline("add_source");
  const transportScalarFieldPipeline = pipeline("transport_scalar_field");
  const dissipatePipeline = pipeline("dissipate");

  // --- render stuff ---

  let renderParamsBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const renderParams = new ArrayBuffer(16);
  const renderParamsView = new DataView(renderParams);
  renderParamsView.setUint32(0, canvas.width, true);
  renderParamsView.setUint32(4, canvas.height, true);
  renderParamsView.setUint32(8, simulation_width, true);
  renderParamsView.setUint32(12, simulation_height, true);
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

  const commandEncoder = device.createCommandEncoder();
  const computePassEncoder = commandEncoder.beginComputePass();
  computePassEncoder.setPipeline(pipeline("init_dye"));
  computePassEncoder.setBindGroup(0, constBindGroup);
  computePassEncoder.setBindGroup(1, uBindGroups[0]);
  computePassEncoder.setBindGroup(2, sBindGroups[0]);
  computePassEncoder.setBindGroup(3, pBindGroups[0]);
  computePassEncoder.dispatchWorkgroups(...num_workgroups);
  computePassEncoder.end();
  device.queue.submit([commandEncoder.finish()]);

  return {
    device: device,
    bindGroups: {
      params: constBindGroup,
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
      jacobiDiffuse: jacobiDiffusePipeline,
      addSource: addSourcePipeline,
      transportScalarField: transportScalarFieldPipeline,
      dissipate: dissipatePipeline,
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
    computeConstBuffer: computeConstBuffer,
    computeConst: computeConst,
    computeConstView: computeConstView,
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

function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

let prev_time = null;
let prev_mouse = { x: 0, y: 0 };
let cnt = 0;

// TODO: if the timestep is too large, just reset the simulation.
function frame(time, state) {
  const js_dt = prev_time === null ? 0 : time - prev_time;
  prev_time = time;

  cnt++;

  const displacement = {
    x: mouseView.getFloat32(0, true) - prev_mouse.x,
    y: mouseView.getFloat32(4, true) - prev_mouse.y,
  };
  mouseView.setFloat32(8, displacement.x, true);
  mouseView.setFloat32(12, displacement.y, true);
  mouseView.setFloat32(32, mouse_radius * mouse_radius, true);
  prev_mouse = {
    x: mouseView.getFloat32(0, true),
    y: mouseView.getFloat32(4, true),
  };

  mouseView.setFloat32(16, 0.4, true);
  mouseView.setFloat32(20, 0.2, true);
  mouseView.setFloat32(24, 0.0, true);

  state.device.queue.writeBuffer(state.mouseBuffer, 0, mouseParams);

  const dpr = window.devicePixelRatio;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);

  const commandEncoder = state.device.createCommandEncoder();

  // --- compute part ---

  const dt = js_dt * time_scale;
  state.computeConstView.setFloat32(76, dt, true);

  const aspect_ratio = canvas.clientWidth / canvas.clientHeight;
  const r_delta_x = simulation_width / aspect_ratio;
  const r_delta_y = simulation_height;
  const sq_r_delta_x = r_delta_x * r_delta_x;
  const sq_r_delta_y = r_delta_y * r_delta_y;
  const sq_delta_x = 1.0 / sq_r_delta_x;
  const sq_delta_y = 1.0 / sq_r_delta_y;
  const laplace_diagonal = -2 * (sq_r_delta_x + sq_r_delta_y);

  state.computeConstView.setFloat32(16, 1 / laplace_diagonal, true);
  state.computeConstView.setFloat32(
    20,
    sq_delta_y / (2 * (sq_delta_x + sq_delta_y)),
    true,
  );
  state.computeConstView.setFloat32(
    24,
    sq_delta_x / (2 * (sq_delta_x + sq_delta_y)),
    true,
  );

  const diffuse_denom = 1.0 - viscosity * dt * laplace_diagonal;

  state.computeConstView.setFloat32(32, 1 / diffuse_denom, true);
  state.computeConstView.setFloat32(
    36,
    (viscosity * dt * sq_r_delta_x) / diffuse_denom,
    true,
  );
  state.computeConstView.setFloat32(
    40,
    (viscosity * dt * sq_r_delta_y) / diffuse_denom,
    true,
  );

  state.computeConstView.setFloat32(48, r_delta_x, true);
  state.computeConstView.setFloat32(52, r_delta_y, true);
  state.computeConstView.setFloat32(56, 0.5 * r_delta_x, true);
  state.computeConstView.setFloat32(60, 0.5 * r_delta_y, true);
  state.computeConstView.setFloat32(64, aspect_ratio, true);

  state.device.queue.writeBuffer(
    state.computeConstBuffer,
    0,
    state.computeConst,
  );

  const computePassEncoder = commandEncoder.beginComputePass();
  computePassEncoder.setBindGroup(0, state.bindGroups.params);
  computePassEncoder.setBindGroup(1, state.bindGroups.u[state.parity.u]);
  computePassEncoder.setBindGroup(2, state.bindGroups.s[state.parity.s]);
  computePassEncoder.setBindGroup(3, state.bindGroups.p[state.parity.p]);

  const set_boundary = (qty_name) => {
    computePassEncoder.setPipeline(state.pipelines.boundary[qty_name].h);
    computePassEncoder.dispatchWorkgroups(simulation_width / 64);
    computePassEncoder.setPipeline(state.pipelines.boundary[qty_name].v);
    computePassEncoder.dispatchWorkgroups(simulation_height / 64);
  };

  if (mouseIsDown) {
    computePassEncoder.setPipeline(state.pipelines.addForce);
    computePassEncoder.dispatchWorkgroups(...num_workgroups);
  }

  set_boundary("velocity");
  computePassEncoder.setPipeline(state.pipelines.transportVelocity);
  computePassEncoder.dispatchWorkgroups(...num_workgroups);
  state.parity.u ^= 1;
  computePassEncoder.setBindGroup(1, state.bindGroups.u[state.parity.u]);

  set_boundary("velocity");
  computePassEncoder.setPipeline(state.pipelines.divergence);
  computePassEncoder.dispatchWorkgroups(...num_workgroups);

  // We "warm-start" from the previous pressure. One could consider doing more iterations
  // if a force is currently active.
  for (let i = 0; i < jacobi_iterations; ++i) {
    set_boundary("pressure");
    computePassEncoder.setPipeline(state.pipelines.jacobiPressure);
    computePassEncoder.dispatchWorkgroups(...num_workgroups);
    state.parity.p ^= 1;
    computePassEncoder.setBindGroup(3, state.bindGroups.p[state.parity.p]);
  }

  set_boundary("pressure");
  computePassEncoder.setPipeline(state.pipelines.subPressureGradient);
  computePassEncoder.dispatchWorkgroups(...num_workgroups);

  // for (let i = 0; i < 10; ++i) {
  //   set_boundary("velocity");
  //   computePassEncoder.setPipeline(state.pipelines.jacobiDiffuse);
  //   computePassEncoder.dispatchWorkgroups(...num_workgroups);
  //   state.parity.u ^= 1;
  //   computePassEncoder.setBindGroup(1, state.bindGroups.u[state.parity.u]);
  // }

  if (mouseIsDown) {
    computePassEncoder.setPipeline(state.pipelines.addSource);
    computePassEncoder.dispatchWorkgroups(...num_workgroups);
  }

  computePassEncoder.setPipeline(state.pipelines.transportScalarField);
  computePassEncoder.dispatchWorkgroups(...num_workgroups);
  state.parity.s ^= 1;
  computePassEncoder.setBindGroup(2, state.bindGroups.s[state.parity.s]);

  computePassEncoder.setPipeline(state.pipelines.dissipate);
  computePassEncoder.dispatchWorkgroups(...num_workgroups);

  computePassEncoder.end();

  // --- render part ---

  state.renderParamsView.setUint32(0, canvas.width, true);
  state.renderParamsView.setUint32(4, canvas.height, true);
  state.device.queue.writeBuffer(
    state.renderParamsBuffer,
    0,
    state.renderParams,
  );

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
    //   state.data.s[state.parity.s],
    //   (simulation_width + 2) * (simulation_height + 2) * 16,
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
    arr[simulation_height * simulation_width],
    arr[simulation_height * simulation_width + 1],
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
