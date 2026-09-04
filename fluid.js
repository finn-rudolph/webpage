let velocityRes = { x: 256, y: 256 };
let dyeRes = { x: 1024, y: 1024 };

const jacobiIterations = 60;

const mouseRadius = 0.05; // radius of the mouse force
const timeScale = 0.05; // the physical time step is `time_scale` * [browser time step in ms]
let forceStrength = 1.0;

const viewportCssPixels = window.innerWidth * window.innerHeight;

if (viewportCssPixels < 600_000) {
  velocityRes = { x: 128, y: 128 };
  dyeRes = { x: 512, y: 512 };
  forceStrength *= 0.5;
} else if (viewportCssPixels < 1_200_000) {
  velocityRes = { x: 192, y: 192 };
  dyeRes = { x: 768, y: 768 };
  forceStrength *= 0.7;
}

const velocityWorkgroups = [velocityRes.x / 8, velocityRes.y / 8];
const dyeWorkgroups = [dyeRes.x / 8, dyeRes.y / 8];

const canvas = document.getElementById("fluidCanvas");

const canvasContext = canvas.getContext("webgpu");

// TODO: remove the no-cache
const computeCode = await fetch("compute.wgsl", { cache: "no-store" }).then(
  (r) => r.text(),
);
const renderCode = await fetch("render.wgsl", { cache: "no-store" }).then((r) =>
  r.text(),
);

export async function init() {
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

  const mouseBuf = device.createBuffer({
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  let mouseArr = new ArrayBuffer(48);
  let mouseView = new DataView(mouseArr);

  let computeConstBuf = device.createBuffer({
    size: 96,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const computeConstArr = new ArrayBuffer(96);
  const computeConstView = new DataView(computeConstArr);

  computeConstView.setUint32(0, velocityRes.x, true);
  computeConstView.setUint32(4, velocityRes.y, true);
  computeConstView.setUint32(8, velocityRes.x + 2, true);
  computeConstView.setUint32(12, velocityRes.y + 2, true);

  computeConstView.setUint32(32, dyeRes.x, true);
  computeConstView.setUint32(36, dyeRes.y, true);
  computeConstView.setUint32(40, dyeRes.x + 2, true);
  computeConstView.setUint32(44, dyeRes.y + 2, true);

  computeConstView.setFloat32(84, forceStrength, true);

  device.queue.writeBuffer(computeConstBuf, 0, computeConstArr);

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

  let constBgr = device.createBindGroup({
    layout: constLayout,
    entries: [
      {
        binding: 0,
        resource: { buffer: mouseBuf },
      },
      {
        binding: 1,
        resource: { buffer: computeConstBuf },
      },
    ],
  });

  // --- u bind group ---

  let uBuf = [];
  for (let i = 0; i < 2; ++i) {
    uBuf[i] = device.createBuffer({
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
  let uEntries = [0, 1].map((i) => ({ binding: i, resource: uBuf[i] }));

  let uBgr = [];
  uBgr[0] = device.createBindGroup({
    layout: uLayout,
    entries: uEntries,
  });
  uEntries[0].binding = 1;
  uEntries[1].binding = 0;
  uBgr[1] = device.createBindGroup({
    layout: uLayout,
    entries: uEntries,
  });

  // --- s bind group ---

  const sTexture = [0, 1].map((_) =>
    device.createTexture({
      size: [dyeRes.x, dyeRes.y],
      format: "rgba16float",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC,
    }),
  );

  const linearSampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });

  let sLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: "float" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: "write-only", format: "rgba16float" },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        sampler: { type: "filtering" },
      },
    ],
  });

  let sEntries = [0, 1].map((i) => ({
    binding: i,
    resource: sTexture[i].createView(),
  }));
  sEntries.push({ binding: 2, resource: linearSampler });

  let sBgr = [];
  sBgr[0] = device.createBindGroup({
    layout: sLayout,
    entries: sEntries,
  });
  sEntries[0].binding = 1;
  sEntries[1].binding = 0;
  sBgr[1] = device.createBindGroup({
    layout: sLayout,
    entries: sEntries,
  });

  // --- p bind groups ---

  let pBuf = [0, 1].map((_) =>
    device.createBuffer({
      size: (velocityRes.x + 2) * (velocityRes.y + 2) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    }),
  );

  let divergenceBuf = device.createBuffer({
    size: (velocityRes.x + 2) * (velocityRes.y + 2) * 4,
    usage: GPUBufferUsage.STORAGE,
  });

  let pLayout = device.createBindGroupLayout({
    entries: [0, 1, 2].map((i) => ({
      binding: i,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "storage" },
    })),
  });

  let pEntries = [
    { binding: 0, resource: pBuf[0] },
    { binding: 1, resource: pBuf[1] },
    { binding: 2, resource: divergenceBuf },
  ];

  let pBgr = [];
  pBgr[0] = device.createBindGroup({
    layout: pLayout,
    entries: pEntries,
  });
  pEntries[0].binding = 1;
  pEntries[1].binding = 0;
  pBgr[1] = device.createBindGroup({
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

  let renderConstBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const renderConstArr = new ArrayBuffer(16);
  const renderConstView = new DataView(renderConstArr);
  renderConstView.setUint32(0, canvas.width, true);
  renderConstView.setUint32(4, canvas.height, true);
  renderConstView.setUint32(8, dyeRes.x, true);
  renderConstView.setUint32(12, dyeRes.y, true);
  device.queue.writeBuffer(renderConstBuf, 0, renderConstArr);

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
  const renderBgrLayout = renderPipeline.getBindGroupLayout(0);

  let renderBgrEntries = [
    {
      binding: 0,
      resource: sTexture[0].createView(),
    },
    {
      binding: 1,
      resource: { buffer: renderConstBuf },
    },
    {
      binding: 2,
      resource: linearSampler,
    },
  ];

  const renderBgr = [];
  renderBgr[0] = device.createBindGroup({
    layout: renderBgrLayout,
    entries: renderBgrEntries,
  });

  renderBgrEntries[0].resource = sTexture[1].createView();
  renderBgr[1] = device.createBindGroup({
    layout: renderBgrLayout,
    entries: renderBgrEntries,
  });

  return {
    device: device,
    bindGroups: {
      params: constBgr,
      u: uBgr,
      s: sBgr,
      p: pBgr,
      render: renderBgr,
    },
    pipelines: {
      addForce: compute_pipeline("add_force"),
      transportDissipateVelocity: compute_pipeline(
        "transport_dissipate_velocity",
      ),
      divergence: compute_pipeline("divergence"),
      jacobiPressure: compute_pipeline("jacobi_pressure"),
      subPressureGradient: compute_pipeline("sub_pressure_gradient"),
      velocityBoundary: compute_pipeline("velocity_boundary"),
      pressureBoundary: compute_pipeline("pressure_boundary"),
      updateDye: compute_pipeline("update_dye"),
      render: renderPipeline,
    },
    parity: {
      u: 0, // whether the current data lives in u0 or u1
      s: 0,
      p: 0,
    },
    mouse: {
      buf: mouseBuf,
      arr: mouseArr,
      view: mouseView,
      isDown: false,
      color: { r: 0, g: 0, b: 0, a: 0 },
    },
    computeConst: {
      buf: computeConstBuf,
      arr: computeConstArr,
      view: computeConstView,
    },
    renderConst: {
      buf: renderConstBuf,
      arr: renderConstArr,
      view: renderConstView,
    },
  };
}

let previous_time = null;
let previousMousePosition = { x: 0, y: 0 };

export function frame(time, state, callback) {
  const js_dt = previous_time === null ? 0 : time - previous_time;
  previous_time = time;

  callback(state, time);

  state.mouse.view.setFloat32(
    8,
    state.mouse.view.getFloat32(0, true) - previousMousePosition.x,
    true,
  );
  state.mouse.view.setFloat32(
    12,
    state.mouse.view.getFloat32(4, true) - previousMousePosition.y,
    true,
  );
  state.mouse.view.setFloat32(
    32,
    mouseRadius * mouseRadius * (state.mouse.isDown ? 1 : -1),
    true,
  );
  previousMousePosition = {
    x: state.mouse.view.getFloat32(0, true),
    y: state.mouse.view.getFloat32(4, true),
  };

  state.mouse.view.setFloat32(16, 1.0 - state.mouse.color.r, true);
  state.mouse.view.setFloat32(20, 1.0 - state.mouse.color.g, true);
  state.mouse.view.setFloat32(24, 1.0 - state.mouse.color.b, true);

  state.device.queue.writeBuffer(state.mouse.buf, 0, state.mouse.arr);

  const dpr = window.devicePixelRatio;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);

  const commandEncoder = state.device.createCommandEncoder();

  // --- compute part ---

  const dt = js_dt * timeScale;
  state.computeConst.view.setFloat32(68, dt, true);

  const aspect_ratio = canvas.clientWidth / canvas.clientHeight;
  state.computeConst.view.setFloat32(64, aspect_ratio, true);

  const vel_r_delta_x = velocityRes.x / aspect_ratio;
  const vel_r_delta_y = velocityRes.y;
  const vel_sq_r_delta_x = vel_r_delta_x * vel_r_delta_x;
  const vel_sq_r_delta_y = vel_r_delta_y * vel_r_delta_y;
  const vel_sq_delta_x = 1.0 / vel_sq_r_delta_x;
  const vel_sq_delta_y = 1.0 / vel_sq_r_delta_y;
  const laplace_diagonal = -2 * (vel_sq_r_delta_x + vel_sq_r_delta_y);

  state.computeConst.view.setFloat32(72, 1 / laplace_diagonal, true);
  state.computeConst.view.setFloat32(
    76,
    vel_sq_delta_y / (2 * (vel_sq_delta_x + vel_sq_delta_y)),
    true,
  );
  state.computeConst.view.setFloat32(
    80,
    vel_sq_delta_x / (2 * (vel_sq_delta_x + vel_sq_delta_y)),
    true,
  );

  state.computeConst.view.setFloat32(16, vel_r_delta_x, true);
  state.computeConst.view.setFloat32(20, vel_r_delta_y, true);
  state.computeConst.view.setFloat32(24, 0.5 * vel_r_delta_x, true);
  state.computeConst.view.setFloat32(28, 0.5 * vel_r_delta_y, true);

  const dye_r_delta_x = dyeRes.x / aspect_ratio;
  const dye_r_delta_y = dyeRes.y;

  state.computeConst.view.setFloat32(48, dye_r_delta_x, true);
  state.computeConst.view.setFloat32(52, dye_r_delta_y, true);
  state.computeConst.view.setFloat32(56, 0.5 * dye_r_delta_x, true);
  state.computeConst.view.setFloat32(60, 0.5 * dye_r_delta_y, true);

  state.device.queue.writeBuffer(
    state.computeConst.buf,
    0,
    state.computeConst.arr,
  );

  const computePassEncoder = commandEncoder.beginComputePass();
  computePassEncoder.setBindGroup(0, state.bindGroups.params);
  computePassEncoder.setBindGroup(1, state.bindGroups.u[state.parity.u]);
  computePassEncoder.setBindGroup(2, state.bindGroups.s[state.parity.s]);
  computePassEncoder.setBindGroup(3, state.bindGroups.p[state.parity.p]);

  if (state.mouse.isDown) {
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

  computePassEncoder.setPipeline(state.pipelines.updateDye);
  computePassEncoder.dispatchWorkgroups(...dyeWorkgroups);
  state.parity.s ^= 1;

  computePassEncoder.end();

  // --- render part ---

  state.renderConst.view.setUint32(0, canvas.width, true);
  state.renderConst.view.setUint32(4, canvas.height, true);
  state.device.queue.writeBuffer(
    state.renderConst.buf,
    0,
    state.renderConst.arr,
  );

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

  // if (cnt % 41 == 0) {
  // debug_buffer(
  //   state.data.u[state.parity.u],
  //   (velocity_res.x + 2) * (velocity_res.y + 2) * 8,
  //   state.device,
  // );
  // debug_texture(
  //   state.data.s[state.parity.s],
  //   dyeRes.x,
  //   dyeRes.y,
  //   state.device,
  // );
  // }

  requestAnimationFrame((time) => frame(time, state, callback));
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
    size: width * height * 8,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();

  encoder.copyTextureToBuffer(
    { texture: input },
    { buffer: buffer, bytesPerRow: width * 8 },
    { width, height },
  );

  device.queue.submit([encoder.finish()]);

  await buffer.mapAsync(GPUMapMode.READ, 0);

  const copyArrayBuffer = buffer.getMappedRange(0, width * height * 8);
  const out = copyArrayBuffer.slice();
  buffer.unmap();
  let arr = new Float32Array(out);
  console.log(arr.slice(10000).every((x) => x === 0));
}
