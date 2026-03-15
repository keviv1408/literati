/**
 * Storybook stories for the BotBadge component.
 * Demonstrates all size variants and usage patterns.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { BotBadge, BotNameTag } from "./BotBadge";

const meta: Meta<typeof BotBadge> = {
  title: "Game/BotBadge",
  component: BotBadge,
  parameters: {
    layout: "centered",
    backgrounds: {
      default: "game-table",
      values: [
        { name: "game-table", value: "#1a2e1a" },
        { name: "light", value: "#ffffff" },
        { name: "dark", value: "#1a1a2e" },
      ],
    },
  },
  argTypes: {
    size: {
      control: "select",
      options: ["xs", "sm", "md", "lg"],
    },
    showName: { control: "boolean" },
  },
};

export default meta;
type Story = StoryObj<typeof BotBadge>;

export const Default: Story = {
  args: {
    displayName: "Quirky Turing",
    size: "md",
    showName: true,
  },
};

export const AllSizes: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", color: "#fff" }}>
      <BotBadge displayName="Zen Einstein" size="xs" />
      <BotBadge displayName="Elegant Curie" size="sm" />
      <BotBadge displayName="Quirky Turing" size="md" />
      <BotBadge displayName="Amazing Lovelace" size="lg" />
    </div>
  ),
};

export const IconOnly: Story = {
  args: {
    displayName: "Clever Darwin",
    size: "md",
    showName: false,
  },
};

export const InPlayerList: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px", color: "#fff" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ opacity: 0.7 }}>Seat 1:</span>
        <BotNameTag name="Alice" isBot={false} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ opacity: 0.7 }}>Seat 2:</span>
        <BotNameTag name="Quirky Turing" isBot={true} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ opacity: 0.7 }}>Seat 3:</span>
        <BotNameTag name="Bob" isBot={false} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ opacity: 0.7 }}>Seat 4:</span>
        <BotNameTag name="Elegant Curie" isBot={true} />
      </div>
    </div>
  ),
};

export const GameTableStyle: Story = {
  render: () => (
    <div
      style={{
        background: "#1a2e1a",
        borderRadius: "12px",
        padding: "24px",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "12px",
        color: "#fff",
        width: "320px",
      }}
    >
      <div style={{ fontSize: "11px", textTransform: "uppercase", opacity: 0.5, gridColumn: "1/-1" }}>
        Team 1
      </div>
      <BotBadge displayName="Quirky Turing" size="sm" />
      <BotBadge displayName="Bold Hawking" size="sm" />
      <BotBadge displayName="Eager Curie" size="sm" />

      <div style={{ fontSize: "11px", textTransform: "uppercase", opacity: 0.5, gridColumn: "1/-1", marginTop: "8px" }}>
        Team 2
      </div>
      <BotBadge displayName="Clever Darwin" size="sm" />
      <BotBadge displayName="Zen Lovelace" size="sm" />
      <BotBadge displayName="Amazing Gauss" size="sm" />
    </div>
  ),
};
