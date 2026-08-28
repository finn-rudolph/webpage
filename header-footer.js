let header = `
  <header>
      <a href="index.html" class="name headerlink">Finn Rudolph</a>

      <nav>
          <a href="research.html", class="headerlink">Research</a>
          <a href="pictures.html", class="headerlink">Pictures</a>
      </nav>
  </header>
`;

let footer = `
  <footer class="footer">
      <div class="footer-left"></div>

      <div class="footer-center">
      <a href="https://github.com/finn-rudolph" aria-label="GitHub">
          <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2.17c-3.2.7-3.87-1.54-3.87-1.54-.53-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.71 1.25 3.37.96.1-.75.4-1.25.73-1.54-2.55-.29-5.23-1.28-5.23-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.77.11 3.06.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.4-5.25 5.68.41.35.78 1.04.78 2.1v3.11c0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"/>
          </svg>
      </a>
      </div>

      <div class="footer-right">
          <video autoplay loop muted src="joel-rotate.mp4">
          Oh nein! NiChT sChOn WiEdEr!
          </video>
      </div>
  </footer>
`;

let main = document.querySelector("main");
main.insertAdjacentHTML("beforebegin", header);
main.insertAdjacentHTML("afterend", footer);
