import { init, frame } from "./fluid.js";

const initialState = await init();

function splash(state, time) {}

requestAnimationFrame((time) => frame(time, initialState, splash));
