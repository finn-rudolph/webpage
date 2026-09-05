import { init, frame, setMousePos, colors } from "./fluid.js";

const canvas = document.getElementById("fluidCanvas");

let mouseIsDown = false;
let color = { r: 0.0, g: 0.0, b: 0.0 };

const initialState = await init();

canvas.addEventListener("pointerdown", (event) => {
  mouseIsDown = true;
  setMousePos(initialState, event.offsetX, event.offsetY);
  color = colors[Math.floor(Math.random() * colors.length)];
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

function updateMouse(state, time) {
  state.mouse.isDown = mouseIsDown;
  state.mouse.color = color;
}

requestAnimationFrame((time) => frame(time, initialState, updateMouse));
