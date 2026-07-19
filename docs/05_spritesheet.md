# **Modular Animation System & Asset Pipeline**

This document outlines the architecture, core concepts, and data formats for the retro soccer game's modular sprite system.
The system separates pixel-art logic from spatial positioning, allowing thousands of frame variations to be built dynamically from a highly compressed, deduplicated bank of modular body parts.

## **Core Concepts**

The pipeline relies on four foundational pillars to reduce memory footprint and enable real-time customization:

1. **Spatial Decoupling (Crop & Center Optimization):** Instead of storing 64x64 transparent canvases for every part, the Python exporter calculates the tightest bounding box for each category across all frames. Parts are cropped, centered inside this minimum common dimension, and hashed. This ensures that identical pixels drawn at different X/Y coordinates resolve to the exact same tile in memory.
2. **The Animation Rig:** Positional data stripped during the optimization phase is injected into a JSON schema. The game engine uses this rig to translate, align, scale, rotate, and layer the raw tiles back into their correct logical coordinates.
3. **Engine-Level Auto-Mirroring:** Only 5 directions are manually drawn or exported (N, NE, E, SE, S). The remaining 3 directions (SW, W, NW) are generated at runtime by horizontally flipping their eastern counterparts.
4. **GPU-Accelerated Palette Swapping:** Tiles are stored as 4-bit indices rather than raw RGBA data. During composition, the engine creates a single "Master Indexed Atlas" where the Red channel holds the palette index (0–15). A WebGL Fragment Shader reads these indices in real-time and maps them to a player-specific 16-color uniform array. This allows the engine to render thousands of unique player variations on the fly with zero per-player memory caching.

## **The Animation Rig Schema (animation\_rig.json)**

The animation rig is the blueprint the client uses to reassemble the cropped tiles into full sprites.

### **Structure Overview**

The JSON file contains metadata about the logical canvas and a dictionary of animations. Each animation contains an array of frames, and each frame contains direction configurations (0 through 4).

JSON
{
  "meta": {
    "version": "1.2",
    "logical\_canvas\_size": \[64, 64\],
    "part\_sizes": {
      "head": \[16, 16\],
      "torso": \[24, 20\]
    },
    "variation\_id": 1
  },
  "animations": {
    "0": {
      "name": "Stand still",
      "frames": \[
        {
          "frame\_index": 0,
          "directions": {
            "0": {
              "parts": \[
                {
                  "part": "torso",
                  "type\_index": 1,
                  "tile\_index": 0,
                  "z": 1,
                  "frame\_anchor": "top\_left",
                  "canvas\_alignment": "top\_left",
                  "relative\_x": 12,
                  "relative\_y": 24,
                  "rotation": 0,
                  "flip\_horizontal": false,
                  "flip\_vertical": false,
                  "scale\_x": 100,
                  "scale\_y": 100
                }
              \]
            }
          }
        }
      \]
    }
  }
}

### **Part Attributes**

Inside the parts array, every object defines exactly how a specific tile should be rendered on the logical 64x64 canvas.

| Attribute | Type | Description |
| :---- | :---- | :---- |
| **part** | String | The category name of the part (e.g., head, torso, legs). Matches the .bin folder. |
| **type\_index** | Integer | The variation ID (allows for future body types or distinct base kits). |
| **tile\_index** | Integer | The specific index to pull from the decompressed .bin file. |
| **z** | Integer | The Z-index (layering order). Lower numbers are drawn first. |
| **frame\_anchor** | String | The local pivot point of the cropped part itself (e.g., top\_left, bottom\_center). Default is top\_left. |
| **canvas\_alignment** | String | The reference point on the master logical canvas where the frame\_anchor is pinned before applying relative offsets (e.g., top\_left, middle\_center). Default is top\_left. |
| **relative\_x** | Integer | Horizontal displacement in pixels applied after the canvas alignment. Default is 0\. |
| **relative\_y** | Integer | Vertical displacement in pixels applied after the canvas alignment. Default is 0\. |
| **rotation** | Float | Rotation angle of the part around its frame\_anchor in degrees (-360 to 360). Default is 0\. |
| **flip\_horizontal** | Boolean | Inverts the part along the Y-axis. Default is false. |
| **flip\_vertical** | Boolean | Inverts the part along the X-axis. Default is false. |
| **scale\_x** | Integer | Horizontal scale percentage. Default is 100\. |
| **scale\_y** | Integer | Vertical scale percentage. Default is 100\. |

## **Pipeline Architecture**

The asset pipeline spans from generation to runtime rendering in two distinct phases.

### **1\. The Exporter (Python)**

The script exporter.py processes raw drawing commands into optimized game assets via a two-pass system:

* **Pass 1 (Measurement):** Generates all permutations of frames and directions, tracking the absolute bounding box for every part category to find the max\_w and max\_h.
* **Pass 2 (Packing):** Crops every generated layer to its tight bounds, centers it inside the category's maximum dimensions, and hashes the byte data.
* **Output:** Unique tiles are packed into 4-bit .bin files and compressed with Zlib. Spatial differences are mathematically converted into alignment markers and relative offsets (relative\_x, relative\_y), then exported to the JSON rig.

### **2\. The Runtime Compositor & WebGL Renderer (JavaScript)**

The engine abandons traditional per-player spritesheet caching in favor of a real-time GPU pipeline. This drastically reduces memory overhead and CPU load.

* **Loading & Indexing:** The engine fetches the compressed .bin files and decompresses the Zlib stream. Instead of converting these immediately to RGB colors, it writes the 4-bit nibbles into the Red channel of a temporary canvas, preserving the raw index (0–15).
* **Master Atlas Compilation:** The engine reads the JSON rig and mathematically applies alignments (canvas\_alignment and frame\_anchor), translations, scaling, mirroring, and rotations to assemble the indexed parts into a single, global 112-frame **Master Indexed Atlas**. This atlas is compiled exactly once and uploaded to the GPU as a WebGL texture.
* **Real-Time Rendering (The Shader):** The engine does not cache individual player sheets. When a specific player needs to be drawn, the game logic passes that player's specific 16-color palette to the GPU as a uniform vec3 array. The WebGL Fragment Shader intercepts the draw call, reads the index from the Master Atlas texture, and outputs the exact RGB color instantly.
* **Memory Impact:** Because colors are applied at the exact moment of rendering, adding 100 new teams or player skin tones costs zero additional texture memory.

### TODO

# Transform Interpolation (Skeletal Animation)

Since you now have an animation rig that supports rotation and scale, you can implement tweening.

    Implementation: Instead of snapping from Frame 1 to Frame 2, the engine can linearly interpolate the relative_x, relative_y, and rotation values between keyframes.

    Impact: Allows for modern, smooth 60 FPS skeletal movement while maintaining a retro pixel-art aesthetic for the body parts themselves.