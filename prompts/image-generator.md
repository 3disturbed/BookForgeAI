---
version: 1
agent: image-generator
---
Renders an image specification into artwork.

This agent calls the configured image model directly with the prompt and the
approved reference images for the assets in the scene. It performs no reasoning
of its own, so this file exists only to version the agent's behaviour alongside
the rest of the prompt library.
