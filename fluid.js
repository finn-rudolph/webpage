let velocityRes = { x: 256, y: 256 };
let dyeRes = { x: 1024, y: 1024 };

const jacobiIterations = 60;

const mouseRadius = 0.05; // radius of the mouse force
const timeScale = 0.05; // the physical time step is `time_scale` * [browser time step in ms]
let forceStrength = 1.4;

const viewportCssPixels = window.innerWidth * window.innerHeight;

if (viewportCssPixels < 600_000) {
  velocityRes = { x: 128, y: 128 };
  dyeRes = { x: 512, y: 512 };
  forceStrength *= 0.5;
} else if (viewportCssPixels < 1_400_000) {
  velocityRes = { x: 192, y: 192 };
  dyeRes = { x: 768, y: 768 };
  forceStrength *= 0.7;
}

const velocityWorkgroups = [velocityRes.x / 8, velocityRes.y / 8];
const dyeWorkgroups = [dyeRes.x / 8, dyeRes.y / 8];

let canvas = document.getElementById("fluidCanvas");

let mouseParams = new ArrayBuffer(48);
let mouseIsDown = false;
let mouseView = new DataView(mouseParams);

const colors = [
  { r: 0.451, g: 0.776, b: 0.851 }, // #73C6D9
  { r: 0.016, g: 0.749, b: 0.749 }, // #04BFBF
  { r: 0.012, g: 0.549, b: 0.549 }, // #038C8C
  { r: 0.537, g: 0.8, b: 0.816 }, // #89CCD0
];
let color = { r: 0.0, g: 0.0, b: 0.0 };

canvas.addEventListener("pointerdown", (event) => {
  mouseIsDown = true;
  mouseView.setFloat32(0, event.offsetX / canvas.clientHeight, true); // this is correct (normalized coords)
  mouseView.setFloat32(4, event.offsetY / canvas.clientHeight, true);
  color = colors[Math.floor(Math.random() * 4)];
});

canvas.addEventListener("pointerup", () => {
  mouseIsDown = false;
});

canvas.addEventListener("pointerleave", () => {
  mouseIsDown = false;
});

canvas.addEventListener("pointercancel", () => {
  mouseIsDown = false;
});

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

  computeConstView.setUint32(0, velocityRes.x, true);
  computeConstView.setUint32(4, velocityRes.y, true);
  computeConstView.setUint32(8, velocityRes.x + 2, true);
  computeConstView.setUint32(12, velocityRes.y + 2, true);

  computeConstView.setUint32(32, dyeRes.x, true);
  computeConstView.setUint32(36, dyeRes.y, true);
  computeConstView.setUint32(40, dyeRes.x + 2, true);
  computeConstView.setUint32(44, dyeRes.y + 2, true);

  computeConstView.setFloat32(84, forceStrength, true);

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
      size: (velocityRes.x + 2) * (velocityRes.y + 2) * 8,
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
      size: (dyeRes.x + 2) * (dyeRes.y + 2) * 16,
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
      size: (velocityRes.x + 2) * (velocityRes.y + 2) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
  }

  let divergenceBuffer = device.createBuffer({
    size: (velocityRes.x + 2) * (velocityRes.y + 2) * 4,
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

  const compute_pipeline = (entryPoint) => {
    return device.createComputePipeline({
      layout: layout,
      compute: {
        module: computeModule,
        entryPoint: entryPoint,
      },
    });
  };

  // --- render stuff ---

  let renderConstBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const renderConst = new ArrayBuffer(16);
  const renderConstView = new DataView(renderConst);
  renderConstView.setUint32(0, canvas.width, true);
  renderConstView.setUint32(4, canvas.height, true);
  renderConstView.setUint32(8, dyeRes.x, true);
  renderConstView.setUint32(12, dyeRes.y, true);
  device.queue.writeBuffer(renderConstBuffer, 0, renderConst);

  let renderBindGroupEntries = [
    {
      binding: 0,
      resource: { buffer: sBuffer[0] },
    },
    {
      binding: 1,
      resource: { buffer: renderConstBuffer },
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
      params: constBindGroup,
      u: uBindGroups,
      s: sBindGroups,
      p: pBindGroups,
      render: renderBindGroups,
    },
    pipelines: {
      addForce: compute_pipeline("add_force"),
      transportDissipateVelocity: compute_pipeline(
        "transport_dissipate_velocity",
      ),
      divergence: compute_pipeline("divergence"),
      jacobiPressure: compute_pipeline("jacobi_pressure"),
      subPressureGradient: compute_pipeline("sub_pressure_gradient"),
      addDye: compute_pipeline("add_dye"),
      transportDissipateDye: compute_pipeline("transport_dissipate_dye"),
      velocityBoundary: compute_pipeline("velocity_boundary"),
      pressureBoundary: compute_pipeline("pressure_boundary"),
      render: renderPipeline,
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
    renderConstBuffer: renderConstBuffer,
    renderConst: renderConst,
    renderConstView: renderConstView,
    data: {
      u: uBuffer,
      s: sBuffer,
      p: pBuffer,
    },
  };
}

let previous_time = null;
let previous_mouse_pos = { x: 0, y: 0 };
let cnt = 0;

// TODO: if the timestep is too large, just reset the simulation.
function frame(time, state) {
  const js_dt = previous_time === null ? 0 : time - previous_time;
  previous_time = time;

  cnt++;

  mouseView.setFloat32(
    8,
    mouseView.getFloat32(0, true) - previous_mouse_pos.x,
    true,
  );
  mouseView.setFloat32(
    12,
    mouseView.getFloat32(4, true) - previous_mouse_pos.y,
    true,
  );
  mouseView.setFloat32(32, mouseRadius * mouseRadius, true);
  previous_mouse_pos = {
    x: mouseView.getFloat32(0, true),
    y: mouseView.getFloat32(4, true),
  };

  mouseView.setFloat32(16, 1.0 - color.r, true);
  mouseView.setFloat32(20, 1.0 - color.g, true);
  mouseView.setFloat32(24, 1.0 - color.b, true);

  state.device.queue.writeBuffer(state.mouseBuffer, 0, mouseParams);

  const dpr = window.devicePixelRatio;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);

  const commandEncoder = state.device.createCommandEncoder();

  // --- compute part ---

  const dt = js_dt * timeScale;
  state.computeConstView.setFloat32(68, dt, true);

  const aspect_ratio = canvas.clientWidth / canvas.clientHeight;
  state.computeConstView.setFloat32(64, aspect_ratio, true);

  const vel_r_delta_x = velocityRes.x / aspect_ratio;
  const vel_r_delta_y = velocityRes.y;
  const vel_sq_r_delta_x = vel_r_delta_x * vel_r_delta_x;
  const vel_sq_r_delta_y = vel_r_delta_y * vel_r_delta_y;
  const vel_sq_delta_x = 1.0 / vel_sq_r_delta_x;
  const vel_sq_delta_y = 1.0 / vel_sq_r_delta_y;
  const laplace_diagonal = -2 * (vel_sq_r_delta_x + vel_sq_r_delta_y);

  state.computeConstView.setFloat32(72, 1 / laplace_diagonal, true);
  state.computeConstView.setFloat32(
    76,
    vel_sq_delta_y / (2 * (vel_sq_delta_x + vel_sq_delta_y)),
    true,
  );
  state.computeConstView.setFloat32(
    80,
    vel_sq_delta_x / (2 * (vel_sq_delta_x + vel_sq_delta_y)),
    true,
  );

  state.computeConstView.setFloat32(16, vel_r_delta_x, true);
  state.computeConstView.setFloat32(20, vel_r_delta_y, true);
  state.computeConstView.setFloat32(24, 0.5 * vel_r_delta_x, true);
  state.computeConstView.setFloat32(28, 0.5 * vel_r_delta_y, true);

  const dye_r_delta_x = dyeRes.x / aspect_ratio;
  const dye_r_delta_y = dyeRes.y;

  state.computeConstView.setFloat32(48, dye_r_delta_x, true);
  state.computeConstView.setFloat32(52, dye_r_delta_y, true);
  state.computeConstView.setFloat32(56, 0.5 * dye_r_delta_x, true);
  state.computeConstView.setFloat32(60, 0.5 * dye_r_delta_y, true);

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

  if (mouseIsDown) {
    computePassEncoder.setPipeline(state.pipelines.addForce);
    computePassEncoder.dispatchWorkgroups(...velocityWorkgroups);
  }

  computePassEncoder.setPipeline(state.pipelines.velocityBoundary);
  computePassEncoder.dispatchWorkgroups(
    Math.max(velocityRes.x, velocityRes.y) / 64,
  );

  computePassEncoder.setPipeline(state.pipelines.transportDissipateVelocity);
  computePassEncoder.dispatchWorkgroups(...velocityWorkgroups);
  state.parity.u ^= 1;
  computePassEncoder.setBindGroup(1, state.bindGroups.u[state.parity.u]);

  computePassEncoder.setPipeline(state.pipelines.velocityBoundary);
  computePassEncoder.dispatchWorkgroups(
    Math.max(velocityRes.x, velocityRes.y) / 64,
  );

  computePassEncoder.setPipeline(state.pipelines.divergence);
  computePassEncoder.dispatchWorkgroups(...velocityWorkgroups);

  // We "warm-start" from the previous pressure. One could consider doing more iterations
  // if a force is currently active.
  for (let i = 0; i < jacobiIterations; ++i) {
    computePassEncoder.setPipeline(state.pipelines.pressureBoundary);
    computePassEncoder.dispatchWorkgroups(
      Math.max(velocityRes.x, velocityRes.y) / 64,
    );

    computePassEncoder.setPipeline(state.pipelines.jacobiPressure);
    computePassEncoder.dispatchWorkgroups(...velocityWorkgroups);
    state.parity.p ^= 1;
    computePassEncoder.setBindGroup(3, state.bindGroups.p[state.parity.p]);
  }

  computePassEncoder.setPipeline(state.pipelines.pressureBoundary);
  computePassEncoder.dispatchWorkgroups(
    Math.max(velocityRes.x, velocityRes.y) / 64,
  );

  computePassEncoder.setPipeline(state.pipelines.subPressureGradient);
  computePassEncoder.dispatchWorkgroups(...velocityWorkgroups);

  if (mouseIsDown) {
    computePassEncoder.setPipeline(state.pipelines.addDye);
    computePassEncoder.dispatchWorkgroups(...dyeWorkgroups);
  }

  computePassEncoder.setPipeline(state.pipelines.transportDissipateDye);
  computePassEncoder.dispatchWorkgroups(...dyeWorkgroups);
  state.parity.s ^= 1;
  computePassEncoder.setBindGroup(2, state.bindGroups.s[state.parity.s]);

  computePassEncoder.end();

  // --- render part ---

  state.renderConstView.setUint32(0, canvas.width, true);
  state.renderConstView.setUint32(4, canvas.height, true);
  state.device.queue.writeBuffer(state.renderConstBuffer, 0, state.renderConst);

  const renderPassDescriptor = {
    colorAttachments: [
      {
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
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
    //   (velocity_res.x + 2) * (velocity_res.y + 2) * 8,
    //   state.device,
    // );
    // debug_buffer(
    //   state.data.s[state.parity.s],
    //   (dye_res.x + 2) * (dye_res.y + 2) * 16,
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
  // console.log(arr.slice()[10000]);
  console.log(arr.slice(10000).every((x) => x === 0));
  console.log(arr.length);
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
