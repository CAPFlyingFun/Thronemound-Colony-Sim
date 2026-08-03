class_name AntMode
extends RefCounted

## What she is currently doing with her mandibles.
##
## The mode is a small state machine that re-purposes the same buttons: left
## click bites soil in Digging and will bite an enemy in Combat. Keeping it as
## a named list rather than a bool means adding Carrying later costs one entry
## here instead of another flag threaded through every input branch.
##
## Walking is deliberately first and deliberately empty. Head PITCH tracks the
## camera in the working modes, which is what lets her reach soil below her --
## but a walking ant that permanently stares wherever the camera looks reads
## as a bull with its head down, so plain locomotion gets its own neutral mode
## where she simply looks ahead.

const WALKING := "walking"
const DIGGING := "digging"
const COMBAT := "combat"
const CARRYING := "carrying"

const ORDER := [WALKING, DIGGING, COMBAT, CARRYING]

const TITLES := {
	WALKING: "Walking",
	DIGGING: "Digging",
	COMBAT: "Combat",
	CARRYING: "Carrying",
}

## Modes where the head aims at what the camera is pointing at, in both axes.
## Yaw tracks in every mode; this is only about pitch.
const AIMS_HEAD := {
	WALKING: false,
	DIGGING: true,
	COMBAT: true,
	CARRYING: true,
}


static func title(mode: String) -> String:
	return TITLES.get(mode, "Walking")


static func aims_head(mode: String) -> bool:
	return bool(AIMS_HEAD.get(mode, false))


## Step through the ring. `step` of -1 walks it backwards.
static func cycle(mode: String, step := 1) -> String:
	var index := ORDER.find(mode)
	if index < 0:
		index = 0
	return ORDER[posmod(index + step, ORDER.size())]
