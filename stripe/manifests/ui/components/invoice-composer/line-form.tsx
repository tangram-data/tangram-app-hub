// Add one line to a draft invoice: a one-off amount (description + amount in the invoice currency) or a
// catalog price id with a quantity.
import { PlusOutlined } from "@ant-design/icons";
import { Button, Input, InputNumber, Radio } from "antd";
import React, { useState } from "react";
import { inputDigits, toMinor } from "../../shared/stripe-format";

export type LineBody =
  | { description: string; amount: number; currency: string }
  | { price: string; quantity: number };

export default function LineForm({
  currency,
  busy,
  onAdd,
}: {
  currency: string;
  busy: boolean;
  // resolves true when the line was added, so the form clears only then
  onAdd: (line: LineBody) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<"amount" | "price">("amount");
  const [description, setDescription] = useState("");
  const [amountText, setAmountText] = useState("");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState<number>(1);

  const amount = toMinor(amountText, currency);
  const valid =
    mode === "amount"
      ? description.trim().length > 0 && amount != null
      : /^price_\w+$/.test(price.trim()) && Number.isInteger(quantity) && quantity >= 1;

  async function add() {
    if (!valid || busy) return;
    const line: LineBody =
      mode === "amount"
        ? { description: description.trim(), amount: amount!, currency }
        : { price: price.trim(), quantity };
    if (await onAdd(line)) {
      setDescription("");
      setAmountText("");
      setPrice("");
      setQuantity(1);
    }
  }

  const step = inputDigits(currency) === 0 ? "1" : inputDigits(currency) === 3 ? "0.001" : "0.01";
  return (
    <div className="s-card soft">
      <div className="s-bar" style={{ marginBottom: 10 }}>
        <Radio.Group
          size="small"
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          options={[
            { label: "One-off amount", value: "amount" },
            { label: "Catalog price", value: "price" },
          ]}
          optionType="button"
          disabled={busy}
        />
      </div>
      {mode === "amount" ? (
        <div className="s-bar">
          <Input
            aria-label="Line description"
            placeholder="Description, e.g. Onboarding workshop"
            value={description}
            disabled={busy}
            onChange={(e) => setDescription(e.target.value)}
            style={{ flex: 1, minWidth: 180 }}
          />
          <Input
            aria-label={`Amount in ${currency.toUpperCase()}`}
            placeholder={`Amount (${currency.toUpperCase()})`}
            inputMode="decimal"
            value={amountText}
            disabled={busy}
            status={amountText && amount == null ? "error" : undefined}
            title={`Up to ${step} precision`}
            onChange={(e) => setAmountText(e.target.value)}
            onPressEnter={add}
            style={{ width: 150 }}
          />
          <Button icon={<PlusOutlined aria-hidden="true" />} disabled={!valid || busy} onClick={add}>
            Add line
          </Button>
        </div>
      ) : (
        <div className="s-bar">
          <Input
            aria-label="Price id"
            placeholder="price_…"
            value={price}
            disabled={busy}
            onChange={(e) => setPrice(e.target.value)}
            style={{ flex: 1, minWidth: 180 }}
          />
          <InputNumber
            aria-label="Quantity"
            min={1}
            precision={0}
            value={quantity}
            disabled={busy}
            onChange={(v) => setQuantity(Number(v) || 1)}
            style={{ width: 100 }}
          />
          <Button icon={<PlusOutlined aria-hidden="true" />} disabled={!valid || busy} onClick={add}>
            Add line
          </Button>
        </div>
      )}
    </div>
  );
}
