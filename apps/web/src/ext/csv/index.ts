// csv extension: ```csv and ```tsv fences render as sortable tables.
// Also the reference extension — copy this folder to add another fence.
import { registerFence } from "../registry";
import CsvTable from "./CsvTable.svelte";

registerFence({ lang: "csv", component: CsvTable, label: "CSV table" });
registerFence({ lang: "tsv", component: CsvTable, label: "TSV table" });
