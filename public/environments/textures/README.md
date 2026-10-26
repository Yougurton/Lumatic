# Environment texture replacements

Most of the files in this directory are deterministic, clean room procedural replacements
They preserve the filenames and pixel dimensions expected by the generated environment data but
do not contain extracted game pixels or third-party artwork.

`chroeditor-*.png` are ChroEditor's own stand-ins for sprites the environment data has no image
for (the game's are not redistributable): an arched leaded window and a soft round glow, drawn
procedurally (see src/engine/renderer/environment/environment-supplements.ts).
