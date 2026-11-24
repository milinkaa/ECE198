# CCCARE Arduino V3 — Motion prescription sync

This is the modified UNO R4 Minima V3 sketch for the Motion Render demo.
It retains the three-axis accelerometer repetition counter, exercise timer,
four buttons, OLED menus, and the existing `EXERCISE,...` USB Serial upload.

## Installation

1. Install the `Adafruit SSD1306` and `Adafruit GFX` libraries in Arduino IDE.
2. Open `firmware/v3/CCCARE_Arduino/CCCARE_Arduino.ino`.
3. Select **Arduino UNO R4 Minima** and the correct USB port. Compile and upload.
4. Close Arduino IDE Serial Monitor; only one app can hold the serial port.
5. In desktop Chrome/Edge, sign in to Motion as the patient. Your instructor
   must assign one of: **Arm Curl**, **Front Arm Raise**, **Lateral Arm Raise**.
6. On the Patient Dashboard choose that plan and click **Connect Arduino**.
   Authorize the port. The browser fetches live targets from Flask then writes
   them over USB Serial. On receipt the Arduino displays the updated prescription.
7. Confirm that the website says **Prescription synced to Arduino OLED**.
   If it does not, do not assume the displayed dose matches the prescription.
8. Complete and confirm a workout. The Arduino still outputs `EXERCISE,...`
   and the browser saves it to the authenticated patient's ProgressLog.

## Serial protocol (115200 baud, newline terminated)

Browser sends:

```text
PLAN,Arm Curl,3,10,120,3
```

Meaning: `PLAN,<exercise name>,<sets>,<reps>,<duration seconds>,<frequency/week>`.
The firmware replies `PLAN_OK,Arm Curl` when accepted, or
`PLAN_ERROR,<reason>` if the command is malformed, the exercise is unsupported,
or a session is already in progress. Unassigned exercises cannot be selected
with the knob while a prescription is synced.

The duration may be `0` when the instructor left it blank; the OLED then says
"Not set". Target **sets** and **frequency** are displayed; the firmware still
tracks one timed exercise session per upload and does not automatically measure
multiple sets. The web app saves each USB Serial record as one completed set.

The prescription is loaded at runtime and is not persisted across Arduino
power cycles. Patients must connect and sync at the beginning of each session.
Only the three arm exercises have V3 accelerometer logic. Using another exercise
from Motion's library will produce a clear error rather than claim to sync it.

## Limitations

- Requires desktop Chrome/Edge and a compatible USB Serial port; some phones
  cannot use Web Serial with this Arduino.
- This prototype does not validate clinical exercise technique.
- Serial data transmission and physical OLED updating must be verified on the
  actual device; GitHub's automated build checks cannot substitute for that.
