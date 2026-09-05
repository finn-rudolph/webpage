import { init, frame, setMousePos, colors } from "./fluid.js";

const canvas = document.getElementById("fluidCanvas");

let t0 = null;
const animationLength = 300;

function splash(state, time) {
  if (t0 === null) {
    t0 = time;
    state.mouse.isDown = true;
    setMousePos(state, 0, 0.5 * canvas.clientHeight);
    state.mouse.color = colors[Math.floor(Math.random() * colors.length)];
  } else if (time - t0 > animationLength) {
    state.mouse.isDown = false;
  } else {
    let a = (time - t0) / animationLength;
    setMousePos(state, a * canvas.clientWidth, 0.5 * canvas.clientHeight);
  }
}

const initialState = await init();
requestAnimationFrame((time) => frame(time, initialState, splash));
