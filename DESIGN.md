---
name: Ehud Radar
description: Provisional styling for the shared marketing workspace
colors:
  primary: "#c9ed83"
  canvas: "#f4f5ef"
  ink: "#242b26"
  muted: "#60675f"
  field: "#fdfefa"
  focus: "#527326"
typography:
  display:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "clamp(34px, 5vw, 44px)"
    fontWeight: 600
    lineHeight: 1.12
    letterSpacing: "-0.035em"
  body:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.65
rounded:
  control: "7px"
spacing:
  medium: "24px"
  large: "48px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#243217"
    rounded: "{rounded.control}"
    padding: "14px 18px"
    height: "52px"
  field:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "13px 14px"
    height: "52px"
---

## Overview
This records the implemented login screen. These are provisional implementation choices, not an official Ehud AI identity. A pale canvas, dark text, and a green primary action keep attention on the task.

## Colors
Use the accent for the main action and muted text for instructions. Errors have a contrasting red text and surface. Fields use one border.

## Typography
DM Sans is self-hosted through the installed font package. Headings use weight and spacing. Usernames use ordinary readable text.

## Layout
The login form has a 400px maximum width, centered between masthead and footer. Page margins reduce from 48px to 24px at 600px. The workspace has a 1120px maximum width. Inputs and primary buttons have a 52px minimum height.

## Elevation & Depth
The interface is flat. Tonal differences and thin dividers separate surfaces; there are no shadows.

## Shapes
Controls have gently rounded corners. Forms sit directly on the page.

## Components
Buttons include hover, disabled, and keyboard focus states. Inputs have persistent labels. Password visibility uses a text control. Focus uses an offset outline. The masthead is a text wordmark, not a claimed official logo.

## Do's and Don'ts
Do use real state and content. Do preserve visible labels and keyboard focus. Do not fill the empty workspace with invented prospect counts or outcomes.
