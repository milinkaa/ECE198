// Browser USB Serial bridge for CCCARE V3/V4 prescription sync and exercise upload.
// Device targets are fetched from the authenticated patient's active plan.
(() => {
  "use strict";

  const panel = document.getElementById("arduino-sync");
  if (!panel) return;

  const connectButton = document.getElementById("arduino-connect");
  const disconnectButton = document.getElementById("arduino-disconnect");
  const planSelect = document.getElementById("arduino-plan");
  const statusNode = document.getElementById("arduino-status");
  const csrfInput = document.getElementById("arduino-csrf");
  const uploadUrl = panel.dataset.uploadUrl;

  if (!connectButton || !disconnectButton || !planSelect || !statusNode || !csrfInput) return;

  let port = null;
  let reader = null;
  let connected = false;
  let disconnectRequested = false;
  let buffer = "";
  let pendingPrescription = null;
  const firmwareExercises = ["Arm Curl", "Front Arm Raise", "Lateral Arm Raise"];
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  function status(message, isError = false) {
    statusNode.textContent = message;
    statusNode.style.color = isError ? "#d64e61" : "";
  }

  function clearPrescription() {
    window.clearTimeout(pendingPrescription?.timeout);
    pendingPrescription = null;
    planSelect.disabled = false;
  }

  async function writePrescription(expected, payload) {
    const writer = port.writable.getWriter();
    try {
      await writer.write(encoder.encode(payload));
    } finally {
      writer.releaseLock();
    }
    if (pendingPrescription !== expected) return;
    expected.timeout = window.setTimeout(() => {
      if (pendingPrescription !== expected) return;
      clearPrescription();
      status("No confirmation from Arduino. Reconnect and check the firmware before starting.", true);
      connected = false;
      void reader?.cancel().catch(() => {});
    }, 4000);
  }

  function parseExerciseRecord(line) {
    const parts = line.trim().split(",");
    if (parts[0] !== "EXERCISE" || parts.length !== 10) return null;

    const fields = {};
    for (let i = 2; i + 1 < parts.length; i += 2) {
      fields[parts[i]] = parts[i + 1];
    }
    const reps = Number(fields.ACTUAL_REPS);
    const seconds = Number(fields.ACTUAL_SECONDS);
    if (!parts[1] || !Number.isInteger(reps) || !Number.isInteger(seconds) ||
        reps < 0 || seconds < 0) {
      throw new Error("Arduino exercise output is not valid.");
    }
    return { exercise_name: parts[1].trim(), actual_reps: reps, actual_seconds: seconds };
  }

  // Fetch fresh targets from Flask rather than trusting an editable browser input.
  async function sendSelectedPrescription() {
    if (!connected || !port?.writable) throw new Error("Arduino is not connected.");
    if (pendingPrescription || planSelect.disabled) return;

    const option = planSelect.selectedOptions[0];
    if (!option?.dataset.prescriptionUrl) {
      throw new Error("Select a patient exercise plan before connecting.");
    }
    const currentPort = port;
    planSelect.disabled = true;
    try {
      const response = await fetch(option.dataset.prescriptionUrl, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store"
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || "Could not retrieve this patient's prescription.");
      }

      const { exercise_name, sets, reps, duration_seconds, frequency_per_week } = result;
      const values = [sets, reps, duration_seconds, frequency_per_week];
      const index = firmwareExercises.indexOf(exercise_name);
      if (index < 0 ||
          !values.every(Number.isInteger) ||
          sets < 1 || sets > 99 || reps < 1 || reps > 1000 ||
          duration_seconds < 0 || duration_seconds > 36000 ||
          frequency_per_week < 1 || frequency_per_week > 7) {
        throw new Error("This exercise prescription is not supported by the connected firmware.");
      }
      if (!connected || port !== currentPort) return;

      const payload = `PLAN,${exercise_name},${sets},${reps},${duration_seconds},${frequency_per_week}\n`;
      const expected = { name: exercise_name, index, reps, seconds: duration_seconds, protocol: "PLAN" };
      pendingPrescription = expected;
      status("Sending " + exercise_name + " (" + sets + " sets × " + reps +
        " reps) to the Arduino. Waiting for device confirmation...");

      expected.write = writePrescription(expected, payload);
      await expected.write;
    } catch (error) {
      if (port !== currentPort) return;
      clearPrescription();
      throw error;
    }
  }

  async function upload(record) {
    const matches = Array.from(planSelect.options).filter(
      option => option.dataset.exercise?.trim().toLowerCase() === record.exercise_name.toLowerCase()
    );
    if (!matches.length) {
      throw new Error("No active plan for '" + record.exercise_name +
        "'. Ask the instructor to assign this exercise.");
    }
    if (matches.length === 1) planSelect.value = matches[0].value;
    else if (!matches.some(option => option.value === planSelect.value)) {
      throw new Error("Multiple matching plans exist. Select the correct one and repeat the session.");
    }

    const payload = { ...record, plan_id: Number(planSelect.value) };
    status("Received " + record.exercise_name + " (" + record.actual_reps +
      " reps, " + record.actual_seconds + " seconds). Saving...");
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": csrfInput.value
      },
      credentials: "same-origin",
      body: JSON.stringify(payload)
    });
    const contentType = response.headers.get("content-type") || "";
    const result = contentType.includes("application/json") ? await response.json() : null;
    if (!response.ok || !result?.ok) {
      throw new Error(result?.error || "Upload failed. Reload the page and sign in again if necessary.");
    }
    status("Exercise saved to your patient profile. Reloading progress...");
    window.location.reload();
  }

  async function handleSerialLine(line) {
    const expected = pendingPrescription;
    if (line === "ERROR,FORMAT" && expected?.protocol === "PLAN") {
      // V4 explicitly rejects PLAN and accepts SET. V3 keeps its existing path.
      await expected.write;
      if (!connected || pendingPrescription !== expected) return;
      window.clearTimeout(expected.timeout);
      if (expected.seconds < 1 || expected.seconds > 3600) {
        clearPrescription();
        status("Arduino v4 requires a duration from 1 to 60 minutes. Ask your instructor to update this plan.", true);
        return;
      }
      expected.protocol = "SET";
      expected.write = writePrescription(expected, `SET,${expected.index},${expected.reps},${expected.seconds}\n`);
      await expected.write;
      return;
    }
    if (line.startsWith("ACK,")) {
      if (expected?.protocol === "SET" && line === `ACK,${expected.index}`) {
        clearPrescription();
        status(`Arduino v4 confirmed ${expected.name}: ${expected.reps} reps, ${expected.seconds} seconds. ` +
          "Select the same exercise on the device. Sets and weekly frequency remain on the website.");
      }
      return;
    }
    if (line.startsWith("ERROR,") && expected?.protocol === "SET") {
      clearPrescription();
      status(line === "ERROR,BUSY"
        ? "Arduino has an active workout. Finish it or reset with B4, then reconnect to send the plan."
        : "Arduino v4 rejected the prescription: " + line.slice("ERROR,".length), true);
      return;
    }
    if (line.startsWith("PLAN_OK,")) {
      const exerciseName = line.slice("PLAN_OK,".length).trim();
      if (expected?.protocol === "PLAN" && expected.name === exerciseName) {
        clearPrescription();
        status("Prescription synced to Arduino OLED: " + exerciseName +
          ". Start the workout and press Confirm to save the result.");
      }
      return;
    }
    if (line.startsWith("PLAN_ERROR,") && expected?.protocol === "PLAN") {
      clearPrescription();
      status("Arduino rejected the prescription: " + line.slice("PLAN_ERROR,".length), true);
      return;
    }
    const record = parseExerciseRecord(line);
    if (record) await upload(record);
  }

  async function readFromDevice() {
    try {
      while (connected && port?.readable) {
        reader = port.readable.getReader();
        try {
          while (connected) {
            const { value, done } = await reader.read();
            if (done) { connected = false; break; }
            buffer += decoder.decode(value, { stream: true });
            let end;
            while ((end = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, end).replace(/\r$/, "").trim();
              buffer = buffer.slice(end + 1);
              if (line) await handleSerialLine(line);
            }
            if (buffer.length > 4096) buffer = buffer.slice(-1024);
          }
        } finally {
          reader.releaseLock();
          reader = null;
        }
      }
    } catch (error) {
      status(error.message || "Unable to read from Arduino.", true);
    } finally {
      connected = false;
      const manualDisconnect = disconnectRequested;
      const write = pendingPrescription?.write;
      clearPrescription();
      disconnectButton.disabled = true;
      await write?.catch(() => {});
      let closeError = null;
      if (port) {
        try {
          await port.close();
        } catch (error) {
          closeError = error;
        } finally {
          port = null;
        }
      }
      connectButton.disabled = false;
      disconnectRequested = false;
      if (manualDisconnect) {
        status(closeError
          ? "The serial port did not close cleanly. Unplug the Arduino, then refresh before reconnecting."
          : "Arduino disconnected. You can reconnect when ready.", Boolean(closeError));
      }
    }
  }

  connectButton.addEventListener("click", async () => {
    if (!("serial" in navigator)) {
      status("Use desktop Google Chrome or Microsoft Edge with HTTPS for USB Serial.", true);
      return;
    }
    if (!planSelect.options.length) {
      status("Your instructor must assign an active exercise plan first.", true);
      return;
    }
    try {
      connectButton.disabled = true;
      // requestPort must be called from a direct user gesture.
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      connected = true;
      buffer = "";
      connectButton.disabled = true;
      disconnectButton.disabled = false;
      void readFromDevice();

      // Allow the microcontroller USB serial connection a moment to initialize.
      await new Promise(resolve => window.setTimeout(resolve, 850));
      if (connected) await sendSelectedPrescription();
    } catch (error) {
      status(error.message || "Could not connect. Close Arduino IDE Serial Monitor and try again.", true);
      connected = false;
      if (reader) {
        try { await reader.cancel(); } catch (_) { /* ignore */ }
      }
      if (port && !reader) {
        try { await port.close(); } catch (_) { /* ignore */ }
        port = null;
      }
      connectButton.disabled = false;
      disconnectButton.disabled = true;
    }
  });

  planSelect.addEventListener("change", () => {
    if (connected) {
      void sendSelectedPrescription().catch(error =>
        status(error.message || "Cannot update Arduino prescription.", true));
    }
  });

  disconnectButton.addEventListener("click", async () => {
    if (disconnectRequested || !port) return;
    disconnectRequested = true;
    connected = false;
    disconnectButton.disabled = true;
    connectButton.disabled = true;
    status("Disconnecting Arduino...");
    const oldPort = port;

    // A pending SerialPort.read() must be cancelled and its reader lock
    // released before SerialPort.close() can complete in readFromDevice().
    try {
      if (reader) {
        await reader.cancel();
      }
      // If the reader has already completed, the read loop's finally block
      // will own the port closure. Never race two close() calls.
    } catch (error) {
      status("Unable to cancel the serial read. Unplug the Arduino and refresh the page.", true);
    }
    window.setTimeout(() => {
      if (disconnectRequested && port === oldPort) {
        status("USB port is taking too long to close. Unplug Arduino and refresh this page before reconnecting.", true);
      }
    }, 5000);
  });
})();

