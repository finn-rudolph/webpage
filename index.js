import { init, frame, setMousePos } from "./fluid.js";

const canvas = document.getElementById("fluidCanvas");

let t0 = 500;
const animationLength = 300;
let started = false;

function splash(state, time) {
  if (!started && time > t0) {
    started = true;
    t0 = time;
    state.mouse.isDown = true;
    setMousePos(state, 0, 0);
    state.mouse.color = {
      r: (Math.random() + 2) / 3,
      g: (Math.random() + 2) / 3,
      b: (Math.random() + 2) / 3,
    };
  } else if (time - t0 > animationLength) {
    state.mouse.isDown = false;
  } else {
    let a = (time - t0) / animationLength;
    setMousePos(state, a * canvas.clientWidth, a * canvas.clientHeight);
  }

  if (time - t0 > 10000) {
    state.stop = true;
  }
}

const initialState = await init();
requestAnimationFrame((time) => frame(time, initialState, splash));
