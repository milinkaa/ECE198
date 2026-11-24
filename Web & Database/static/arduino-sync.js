// Browser USB Serial bridge for CCCARE V3 prescription sync and exercise upload.
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
  let buffer = "";
  let pendingPrescription = null;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  function status(message, isError = false) {
    statusNode.textContent = message;
    statusNode.style.color = isError ? "#d64e61" : "";
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

    const option = planSelect.selectedOptions[0];
    if (!option?.dataset.prescriptionUrl) {
      throw new Error("Select a patient exercise plan before connecting.");
    }
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
    if (!["Arm Curl", "Front Arm Raise", "Lateral Arm Raise"].includes(exercise_name) ||
        !values.every(Number.isInteger) ||
        sets < 1 || sets > 99 || reps < 1 || reps > 1000 ||
        duration_seconds < 0 || duration_seconds > 36000 ||
        frequency_per_week < 1 || frequency_per_week > 7) {
      throw new Error("This exercise prescription is not supported by the connected firmware.");
    }

    const payload = `PLAN,${exercise_name},${sets},${reps},${duration_seconds},${frequency_per_week}\n`;
    const expected = { name: exercise_name, planId: result.plan_id };
    pendingPrescription = expected;
    status("Sending " + exercise_name + " (" + sets + " sets × " + reps +
      " reps) to the Arduino. Waiting for device confirmation...");

    const writer = port.writable.getWriter();
    try {
      await writer.write(encoder.encode(payload));
    } finally {
      writer.releaseLock();
    }

    // An old V2/V3 sketch can still upload records, but cannot accept PLAN data.
    window.setTimeout(() => {
      if (connected && pendingPrescription === expected) {
        status("No PLAN_OK confirmation from Arduino. Upload the updated dose-sync V3 firmware; the old sketch still uses preset targets.", true);
      }
    }, 4000);
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
    if (line.startsWith("PLAN_OK,")) {
      const exerciseName = line.slice("PLAN_OK,".length).trim();
      if (pendingPrescription?.name === exerciseName) {
        pendingPrescription = null;
        status("Prescription synced to Arduino OLED: " + exerciseName +
          ". Start the workout and press Confirm to save the result.");
      }
      return;
    }
    if (line.startsWith("PLAN_ERROR,")) {
      pendingPrescription = null;
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
            if (done) break;
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
      pendingPrescription = null;
      connectButton.disabled = false;
      disconnectButton.disabled = true;
      if (port) {
        try { await port.close(); } catch (_) { /* already disconnected */ }
        port = null;
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
    connected = false;
    pendingPrescription = null;
    if (reader) {
      try { await reader.cancel(); } catch (_) { /* already disconnected */ }
    }
    status("Disconnecting Arduino...");
  });
})();
