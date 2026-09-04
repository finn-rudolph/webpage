import { init, frame } from "./fluid.js";

const canvas = document.getElementById("fluidCanvas");

let mouseIsDown = false;
let color = { r: 0.0, g: 0.0, b: 0.0 };

const initialState = await init();

const colors = [
  { r: 0.451, g: 0.776, b: 0.851 }, // #73C6D9
  { r: 0.016, g: 0.749, b: 0.749 }, // #04BFBF
  { r: 0.012, g: 0.549, b: 0.549 }, // #038C8C
  { r: 0.537, g: 0.8, b: 0.816 }, // #89CCD0
];

canvas.addEventListener("pointerdown", (event) => {
  mouseIsDown = true;
  initialState.mouse.view.setFloat32(
    0,
    event.offsetX / canvas.clientHeight,
    true,
  ); // this is correct (normalized coords)
  initialState.mouse.view.setFloat32(
    4,
    event.offsetY / canvas.clientHeight,
    true,
  );
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
  initialState.mouse.view.setFloat32(
    0,
    event.offsetX / canvas.clientHeight,
    true,
  );
  initialState.mouse.view.setFloat32(
    4,
    event.offsetY / canvas.clientHeight,
    true,
  );
});

function updateMouse(state, time) {
  state.mouse.isDown = mouseIsDown;
  state.mouse.color = color;
}

requestAnimationFrame((time) => frame(time, initialState, updateMouse));
