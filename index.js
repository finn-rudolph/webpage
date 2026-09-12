import { init, frame, setMousePos, hsvToRgb } from "./fluid.js";

const canvas = document.getElementById("fluidCanvas");

let t0 = 300;
const animationLength = 800;
let started = false;
const aspect_ratio = canvas.clientWidth / canvas.clientHeight;
const r = Math.min(0.3, aspect_ratio * 0.4);

function splash(state, time) {
  if (!started && time > t0) {
    started = true;
    t0 = time;
    state.mouse.isDown = true;
    setMousePos(state, aspect_ratio / 2 + r, 0.5);
    state.mouse.color = hsvToRgb(Math.random(), 0.9, 1.0);
  } else if (time - t0 > animationLength) {
    state.mouse.isDown = false;
  } else {
    let a = (3 * Math.PI * (time - t0)) / animationLength;
    setMousePos(
      state,
      0.5 * aspect_ratio + Math.cos(a) * r,
      0.5 + Math.sin(a) * r,
    );
  }

  if (time - t0 > 10000) {
    state.stop = true;
  }
}

const initialState = await init();
requestAnimationFrame((time) => frame(time, initialState, splash));
