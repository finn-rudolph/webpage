import { init, frame, setMousePos, hsvToRgb } from "./fluid.js";

const canvas = document.getElementById("fluidCanvas");

let animation_delay = 300;
let animation_start = null;
const animationLength = 800;
let started = false;
let event_loop_runs = false;
const aspect_ratio = canvas.clientWidth / canvas.clientHeight;
const r = 0.3 * Math.min(1.0, aspect_ratio);

function splash(state, time) {
  if (!event_loop_runs) {
    event_loop_runs = true;
    animation_start = time + animation_delay;
  }
  if (!started && time > animation_start) {
    started = true;
    state.mouse.isDown = true;
    setMousePos(state, aspect_ratio / 2 + r, 0.5);
    state.mouse.color = hsvToRgb(Math.random(), 0.9, 1.0);
  } else if (time - animation_start > animationLength) {
    state.mouse.isDown = false;
  } else {
    let a = (3 * Math.PI * (time - animation_start)) / animationLength;
    setMousePos(
      state,
      0.5 * aspect_ratio + Math.cos(a) * r,
      0.5 + Math.sin(a) * r,
    );
  }

  if (time - animation_start > 10000) {
    state.stop = true;
  }
}

const initialState = await init();
requestAnimationFrame((time) => frame(time, initialState, splash));
