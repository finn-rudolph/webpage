import { init, frame, setMousePos, hsvToRgb } from "./fluid.js";

const canvas = document.getElementById("fluidCanvas");

let animation_delay = 300;
let animation_start = null;
const animationLength = 340;
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
    setMousePos(state, 0.0, 0.0);
    state.mouse.color = hsvToRgb(Math.random(), 0.9, 1.0);
  } else if (time - animation_start > animationLength) {
    state.mouse.isDown = false;
  } else {
    setMousePos(
      state,
      (time - animation_start) * aspect_ratio / animationLength,
      (time - animation_start) / animationLength,
    );
  }

  if (time - animation_start > 10000) {
    state.stop = true;
  }
}

const initialState = await init();
requestAnimationFrame((time) => frame(time, initialState, splash));
