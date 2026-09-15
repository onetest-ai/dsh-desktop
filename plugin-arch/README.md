# @onetest/dsh-arch

Architecture diagrams that live in your project.

Boxes with typed labels, connectors carrying prose, nested as deep as the
architecture goes. Visually it owes a great deal to IcePanel. Structurally it
does not: there are no enforced C4 levels and no rules about which kind of box
may appear where. C4 is a convention you may follow.

This package is the model and the tools that maintain it. The drawing surface —
the canvas you place boxes on — is not here yet; today the diagrams are built
and edited by the coding agent, and read as files.

## Where the diagrams live

One JSON file per diagram, under `.dsh/arch/` in the open project. The files are
the diagrams; git is their history. Nothing lives in a database and nothing
leaves your machine.

## What the agent can do

Six tools: list, read, create, edit, search icons, and — once the canvas
exists — look at the rendered result. The agent maintains diagrams as a side
effect of changing the code.

It cannot move a box you placed. Positions are inferred for boxes nobody has
placed; the moment you drag one, that position is yours and nothing automatic
touches it again. There is deliberately no tool to pin, unpin, or re-run layout.

## Install

```sh
dsh plugin --profile web add @onetest/dsh-arch
```

## What it is not

It does not sync anywhere, share anything, or talk to a server. There are no
accounts, no teams, and no permissions — this is a local tool over a git
checkout.
