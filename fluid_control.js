import { init, frame, setMousePos, setRes } from "./fluid.js";

const canvas = document.getElementById("fluidCanvas");

let mouseIsDown = false;
let freq = { r: 0.0, g: 0.0, b: 0.0 };

let initialState = await init();

canvas.addEventListener("pointerdown", (event) => {
  mouseIsDown = true;
  setMousePos(initialState, event.offsetX, event.offsetY);
  const time_scale = 500;
  freq = {
    r: Math.random() / time_scale,
    g: Math.random() / time_scale,
    b: Math.random() / time_scale,
  };
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
  setMousePos(initialState, event.offsetX, event.offsetY);
});

const aboutThisButton = document.querySelector("#about");
const aboutThisContent = document.querySelector("#info div");

aboutThisButton.addEventListener("click", () => {
  aboutThisContent.classList.toggle("hidden");
});

function updateMouse(state, time) {
  state.mouse.isDown = mouseIsDown;
  state.mouse.color = {
    r: (Math.sin(time * freq.r) + 1) / 2,
    g: (Math.sin(time * freq.g) + 1) / 2,
    b: (Math.sin(time * freq.b) + 1) / 2,
  };
}

const highResButton = document.querySelector("#highRes");
let highResActive = false;

highResButton.addEventListener("click", async () => {
  aboutThisContent.classList.toggle("hidden");
  if (!highResActive) {
    highResActive = true;
    initialState.stop = true;
    setRes({ x: 768, y: 768 }, { x: 2048, y: 2048 });
    initialState = await init();
    requestAnimationFrame((time) => frame(time, initialState, updateMouse));
  }
});

requestAnimationFrame((time) => frame(time, initialState, updateMouse));
