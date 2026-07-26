import { BrowserMultiFormatReader, BrowserMultiFormatOneDReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

const els = {
      addBtn: document.querySelector("#addBtn"),
      bookForm: document.querySelector("#bookForm"),
      clearBtn: document.querySelector("#clearBtn"),
      codeInput: document.querySelector("#codeInput"),
      exportBtn: document.querySelector("#exportBtn"),
      foundAuthor: document.querySelector("#foundAuthor"),
      foundCode: document.querySelector("#foundCode"),
      foundTitle: document.querySelector("#foundTitle"),
      locationInput: document.querySelector("#locationInput"),
      lookupBtn: document.querySelector("#lookupBtn"),
      message: document.querySelector("#message"),
      printBtn: document.querySelector("#printBtn"),
      scanBtn: document.querySelector("#scanBtn"),
      scanner: document.querySelector("#scanner"),
      scannerStatus: document.querySelector("#scannerStatus"),
      searchInput: document.querySelector("#searchInput"),
      summary: document.querySelector("#summary"),
      tableWrap: document.querySelector("#tableWrap"),
      cameraControls: document.querySelector("#cameraControls"),
      photoBtn: document.querySelector("#photoBtn"),
      photoInput: document.querySelector("#photoInput"),
      torchBtn: document.querySelector("#torchBtn"),
      zoomControl: document.querySelector("#zoomControl"),
      zoomInput: document.querySelector("#zoomInput"),
      video: document.querySelector("#video")
    };

    const storeKey = "singlePageBookInventory.v1";
    let books = loadBooks();
    let currentBook = null;
    let stream = null;
    let detector = null;
    let zxingReader = null;
    let zxingControls = null;
    let zxingCanvas = document.createElement("canvas");
    let zxingLoopFrame = null;
    let zxingDecodeBusy = false;
    let zxingLastAttempt = 0;
    let activeVideoTrack = null;
    let torchOn = false;
    let scanning = false;
    let lastDetected = "";

    function loadBooks() {
      try {
        return JSON.parse(localStorage.getItem(storeKey)) || [];
      } catch {
        return [];
      }
    }

    function saveBooks() {
      localStorage.setItem(storeKey, JSON.stringify(books));
    }

    function normalizeCode(value) {
      return String(value || "").replace(/[^\dXx]/g, "").toUpperCase();
    }

    function cleanIsbn(code) {
      if (code.length === 13 && (code.startsWith("978") || code.startsWith("979"))) return code;
      if (code.length === 10) return code;
      return code;
    }

    function setMessage(text, kind = "") {
      els.message.textContent = text;
      els.message.className = `message ${kind}`.trim();
    }

    function setCurrentBook(book) {
      currentBook = book;
      els.foundTitle.textContent = book ? book.title : "No book selected yet";
      els.foundAuthor.textContent = book ? book.author : "Scan or enter a book barcode to fetch details.";
      els.foundCode.textContent = book ? `Code: ${book.code}` : "";
      els.addBtn.disabled = !book;
    }

    async function lookupBook(codeValue) {
      const code = cleanIsbn(normalizeCode(codeValue));
      if (!code) {
        setMessage("Enter or scan an ISBN or UPC first.", "warn");
        return;
      }

      setMessage("Looking up book details...");
      els.lookupBtn.disabled = true;

      try {
        const book = await lookupOpenLibrary(code) || await lookupGoogleBooks(code);
        if (!book) {
          setCurrentBook({ title: "Unknown title", author: "Unknown author", code });
          setMessage("No match found. You can still add it, then edit the inventory later by re-adding with a better lookup.", "warn");
          return;
        }
        setCurrentBook({ ...book, code });
        setMessage("Book details found.");
      } catch (error) {
        setCurrentBook({ title: "Unknown title", author: "Unknown author", code });
        setMessage("Lookup was blocked or unavailable. The book can still be added with unknown details.", "warn");
      } finally {
        els.lookupBtn.disabled = false;
      }
    }

    async function lookupOpenLibrary(code) {
      const params = new URLSearchParams({
        bibkeys: `ISBN:${code}`,
        jscmd: "data",
        format: "json"
      });
      const dataResponse = await fetch(`https://openlibrary.org/api/books?${params.toString()}`);
      if (dataResponse.ok) {
        const data = await dataResponse.json();
        const book = data[`ISBN:${code}`];
        if (book) {
          return {
            title: book.title || "Unknown title",
            author: Array.isArray(book.authors) && book.authors.length
              ? book.authors.map(author => author.name).filter(Boolean).join(", ") || "Unknown author"
              : "Unknown author"
          };
        }
      }

      const response = await fetch(`https://openlibrary.org/isbn/${encodeURIComponent(code)}.json`);
      if (!response.ok) return null;
      const data = await response.json();
      let author = "Unknown author";

      if (Array.isArray(data.authors) && data.authors[0]?.key) {
        try {
          const authorResponse = await fetch(`https://openlibrary.org${data.authors[0].key}.json`);
          if (authorResponse.ok) {
            const authorData = await authorResponse.json();
            author = authorData.name || author;
          }
        } catch {
          author = "Unknown author";
        }
      }

      return {
        title: data.title || "Unknown title",
        author
      };
    }

    async function lookupGoogleBooks(code) {
      const params = new URLSearchParams({ q: `isbn:${code}` });
      const response = await fetch(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`);
      if (!response.ok) return null;
      const data = await response.json();
      const info = data.items?.[0]?.volumeInfo;
      if (!info) return null;
      return {
        title: info.title || "Unknown title",
        author: Array.isArray(info.authors) && info.authors.length ? info.authors.join(", ") : "Unknown author"
      };
    }

    async function toggleScan() {
      if (scanning) {
        stopScan();
        return;
      }

    //   if ("BarcodeDetector" in window) {
    //     await startNativeScan();
    //     return;
    //   }

      if (BrowserMultiFormatReader) {
        await startZxingScan();
        return;
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        els.scanner.classList.add("unsupported");
        els.scannerStatus.textContent = "This browser does not provide camera access. Manual entry is ready below.";
        setMessage("Camera scanning is not available in this browser. Type the ISBN or UPC instead.", "warn");
        return;
      }

      els.scanner.classList.add("unsupported");
      els.scannerStatus.textContent = "The barcode scanner library could not load. Manual entry is ready below.";
      setMessage("Scanner support could not load. Check your connection or type the ISBN/UPC instead.", "warn");
    }

    async function startNativeScan() {
      try {
        detector = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"] });
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 }
          }
        });
        els.video.srcObject = stream;
        await els.video.play();
        await setupCameraEnhancements();
        scanning = true;
        els.scanner.classList.add("active");
        els.scanBtn.lastChild.textContent = " Stop";
        els.scannerStatus.textContent = "Hold the book farther back if the bars blur, then zoom in.";
        setMessage("Scanning...");
        scanLoop();
      } catch (error) {
        els.scannerStatus.textContent = "Camera access was not available. Manual entry is ready below.";
        setMessage("Camera access was blocked or unavailable. Type the ISBN or UPC instead.", "warn");
      }
    }

    async function startZxingScan() {
      try {
        zxingReader = createOneDimensionalReader();
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 }
          }
        });
        els.video.srcObject = stream;
        await els.video.play();
        await setupCameraEnhancements();
        scanning = true;
        els.scanner.classList.add("active");
        els.cameraControls.classList.add("visible");
        els.scanBtn.lastChild.textContent = " Stop";
        els.scannerStatus.textContent = "Center only the main ISBN/UPC bars. Keep it sharp and fill about half the view.";
        setMessage("Scanning sharp live frames for ISBN/UPC bars...");
        scanZxingVideoFrame();
      } catch (error) {
        console.log(error);
        scanning = false;
        zxingReader = null;
        zxingControls = null;
        els.scanner.classList.remove("active");
        els.scanBtn.lastChild.textContent = " Scan";
        els.scannerStatus.textContent = "Camera access was not available. Manual entry is ready below.";
        setMessage("Camera access was blocked or unavailable. Type the ISBN or UPC instead.", "warn");
      }
    }

    function stopScan() {
      scanning = false;
      if (zxingLoopFrame) {
        cancelAnimationFrame(zxingLoopFrame);
      }
      zxingLoopFrame = null;
      zxingDecodeBusy = false;
      resetCameraControls();
      if (zxingControls?.stop) {
        zxingControls.stop();
      }
      if (zxingReader?.reset) {
        zxingReader.reset();
      }
      zxingControls = null;
      zxingReader = null;
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      stream = null;
      els.video.srcObject = null;
      els.scanner.classList.remove("active");
      els.scanBtn.lastChild.textContent = " Scan";
      els.scannerStatus.textContent = "Scanner stopped. Start it again or enter a code manually.";
    }

    async function setupCameraEnhancements() {
      activeVideoTrack = els.video.srcObject?.getVideoTracks?.()[0] || stream?.getVideoTracks?.()[0] || null;
      if (!activeVideoTrack) return;

      try {
        await activeVideoTrack.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
      } catch {
        // Some mobile browsers ignore or reject focus constraints.
      }

      const capabilities = activeVideoTrack.getCapabilities?.() || {};
      const settings = activeVideoTrack.getSettings?.() || {};
      let hasControls = false;

      if (capabilities.zoom) {
        els.zoomInput.min = capabilities.zoom.min ?? 1;
        els.zoomInput.max = capabilities.zoom.max ?? 1;
        els.zoomInput.step = capabilities.zoom.step ?? 0.1;
        els.zoomInput.value = settings.zoom ?? capabilities.zoom.min ?? 1;
        els.zoomControl.classList.add("visible");
        hasControls = true;
      }

      if (capabilities.torch) {
        els.torchBtn.style.display = "inline-flex";
        hasControls = true;
      } else {
        els.torchBtn.style.display = "none";
      }

      els.cameraControls.classList.add("visible");
    }

    function resetCameraControls() {
      activeVideoTrack = null;
      torchOn = false;
      els.cameraControls.classList.remove("visible");
      els.zoomControl.classList.remove("visible");
      els.torchBtn.style.display = "none";
      els.torchBtn.classList.remove("primary");
    }

    function createOneDimensionalReader() {
      const hints = new Map();
      hints.set(DecodeHintType.TRY_HARDER, true);
    const formats = [
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E
    ].filter(format => format !== undefined);
    console.log(formats);
        if (formats.length) {
          hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
        }
        hints.set(DecodeHintType.TRY_INVERTED, true);
      return new BrowserMultiFormatOneDReader(hints);
    }

    async function scanZxingVideoFrame(timestamp = 0) {
      if (!scanning || !zxingReader) return;

      if (!zxingDecodeBusy && timestamp - zxingLastAttempt > 240 && els.video.readyState >= 2) {
        zxingLastAttempt = timestamp;
        zxingDecodeBusy = true;
        try {
          const raw = await decodeLiveVideoFrame();
          if (raw && raw !== lastDetected) {
            lastDetected = raw;
            els.codeInput.value = raw;
            stopScan();
            await lookupBook(raw);
            els.locationInput.focus();
            return;
          }
        } catch {
          // Most frames will not decode; keep sampling until the user stops scanning.
        } finally {
          zxingDecodeBusy = false;
        }
      }

      zxingLoopFrame = requestAnimationFrame(scanZxingVideoFrame);
    }

    async function decodeLiveVideoFrame() {
      const sourceWidth = els.video.videoWidth;
      const sourceHeight = els.video.videoHeight;
      if (!sourceWidth || !sourceHeight) return "";

      const scanBands = [
        { y: 0.34, h: 0.32 },
        { y: 0.24, h: 0.32 },
        { y: 0.44, h: 0.32 },
        { y: 0.16, h: 0.68 }
      ];

      for (const band of scanBands) {
        const raw = await decodeVideoBand(sourceWidth, sourceHeight, band);
        if (raw) return raw;
      }

      return "";
    }

    async function decodeVideoBand(sourceWidth, sourceHeight, band) {
      const sourceY = Math.max(0, Math.floor(sourceHeight * band.y));
      const sourceH = Math.min(sourceHeight - sourceY, Math.floor(sourceHeight * band.h));
      const outputWidth = Math.min(1800, Math.max(1000, sourceWidth));
      const outputHeight = Math.max(260, Math.round(outputWidth * (sourceH / sourceWidth)));
      const context = zxingCanvas.getContext("2d", { willReadFrequently: true });

      zxingCanvas.width = outputWidth;
      zxingCanvas.height = outputHeight;
      context.filter = "grayscale(1) contrast(2.2) brightness(1.08)";
      context.drawImage(els.video, 0, sourceY, sourceWidth, sourceH, 0, 0, outputWidth, outputHeight);
      context.filter = "none";

      try {
        const result = await zxingReader.decodeFromCanvas(zxingCanvas);
        return normalizeCode(result?.getText?.());
      } catch {
        return "";
      }
    }

    async function scanPhoto(event) {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;

      if (!BrowserMultiFormatOneDReader) {
        setMessage("Photo scanning could not load. Type the ISBN or UPC instead.", "warn");
        return;
      }

      const image = new Image();
      const url = URL.createObjectURL(file);
      image.src = url;
      setMessage("Scanning photo...");

      try {
        await image.decode();
        const reader = createOneDimensionalReader();
        const result = await reader.decodeFromImageElement(image);
        const raw = normalizeCode(result?.getText?.());
        if (!raw) throw new Error("No barcode result");
        els.codeInput.value = raw;
        await lookupBook(raw);
        els.locationInput.focus();
      } catch {
        setMessage("No UPC/ISBN found in that photo. Try filling the photo with the barcode while keeping it sharp.", "warn");
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    async function applyZoom() {
      if (!activeVideoTrack) return;
      try {
        await activeVideoTrack.applyConstraints({ advanced: [{ zoom: Number(els.zoomInput.value) }] });
      } catch {
        setMessage("This camera would not accept that zoom level.", "warn");
      }
    }

    async function toggleTorch() {
      if (!activeVideoTrack) return;
      torchOn = !torchOn;
      try {
        await activeVideoTrack.applyConstraints({ advanced: [{ torch: torchOn }] });
        els.torchBtn.classList.toggle("primary", torchOn);
      } catch {
        torchOn = false;
        els.torchBtn.classList.remove("primary");
        setMessage("This camera would not turn on the light from the browser.", "warn");
      }
    }

    async function scanLoop() {
      if (!scanning || !detector) return;
      try {
        const codes = await detector.detect(els.video);
        const raw = normalizeCode(codes[0]?.rawValue);
        if (raw && raw !== lastDetected) {
          lastDetected = raw;
          els.codeInput.value = raw;
          stopScan();
          await lookupBook(raw);
          els.locationInput.focus();
          return;
        }
      } catch {
        setMessage("Scanner had trouble reading that frame. Keep the barcode centered.");
      }
      requestAnimationFrame(scanLoop);
    }

    function addBook(event) {
      event.preventDefault();
      if (!currentBook) return;
      const location = els.locationInput.value.trim();
      if (!location) {
        setMessage("Add a storage location before saving.", "warn");
        els.locationInput.focus();
        return;
      }

      const added = {
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
        title: currentBook.title,
        author: currentBook.author,
        code: currentBook.code,
        location,
        addedAt: new Date().toISOString()
      };

      books = [added, ...books];
      saveBooks();
      renderInventory();
      setMessage(`Added "${added.title}" to inventory.`);
      els.codeInput.value = "";
      els.locationInput.value = "";
      setCurrentBook(null);
      els.codeInput.focus();
    }

    function removeBook(id) {
      books = books.filter(book => book.id !== id);
      saveBooks();
      renderInventory();
    }

    function clearInventory() {
      if (!books.length) return;
      if (confirm("Clear all books from this browser inventory?")) {
        books = [];
        saveBooks();
        renderInventory();
      }
    }

    function renderInventory() {
      const query = els.searchInput.value.trim().toLowerCase();
      const filtered = books.filter(book => {
        const haystack = `${book.title} ${book.author} ${book.location} ${book.code}`.toLowerCase();
        return haystack.includes(query);
      });

      els.summary.innerHTML = `
        <span>${books.length} ${books.length === 1 ? "book" : "books"}</span>
        <span>${new Set(books.map(book => book.location)).size} ${books.length === 1 ? "location" : "locations"}</span>
        <span class="screen-only">${filtered.length} shown</span>
      `;

      if (!filtered.length) {
        els.tableWrap.innerHTML = `<div class="empty">${books.length ? "No books match that search." : "No books added yet. Scan or enter an ISBN to begin."}</div>`;
        return;
      }

      els.tableWrap.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Author</th>
              <th>Stored Where</th>
              <th>Code</th>
              <th>Date Added</th>
              <th aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map(book => `
              <tr>
                <td>${escapeHtml(book.title)}</td>
                <td>${escapeHtml(book.author)}</td>
                <td>${escapeHtml(book.location)}</td>
                <td>${escapeHtml(book.code)}</td>
                <td>${new Date(book.addedAt).toLocaleDateString()}</td>
                <td>
                  <button class="icon-btn" data-remove="${book.id}" type="button" title="Remove book" aria-label="Remove ${escapeHtml(book.title)}">
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                  </button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `;

      els.tableWrap.querySelectorAll("[data-remove]").forEach(button => {
        button.addEventListener("click", () => removeBook(button.dataset.remove));
      });
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      }[char]));
    }

    function exportCsv() {
      const headers = ["Title", "Author", "Stored Where", "Code", "Date Added"];
      const rows = books.map(book => [book.title, book.author, book.location, book.code, new Date(book.addedAt).toLocaleDateString()]);
      const csv = [headers, ...rows]
        .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","))
        .join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "book-inventory.csv";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    els.scanBtn.addEventListener("click", toggleScan);
    els.lookupBtn.addEventListener("click", () => lookupBook(els.codeInput.value));
    els.bookForm.addEventListener("submit", addBook);
    els.printBtn.addEventListener("click", () => window.print());
    els.exportBtn.addEventListener("click", exportCsv);
    els.clearBtn.addEventListener("click", clearInventory);
    els.photoBtn.addEventListener("click", () => els.photoInput.click());
    els.photoInput.addEventListener("change", scanPhoto);
    els.zoomInput.addEventListener("input", applyZoom);
    els.torchBtn.addEventListener("click", toggleTorch);
    els.searchInput.addEventListener("input", renderInventory);
    els.codeInput.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        lookupBook(els.codeInput.value);
      }
    });

    renderInventory();