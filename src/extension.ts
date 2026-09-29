import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';

import { XMLParser } from 'fast-xml-parser';

/* ========================================================================== */
/*                                   SVD                                      */
/* ========================================================================== */

interface SvdEnumValue {
    name: string;
    value: bigint;
    description?: string;
}

interface SvdWriteConstraint {
    writeAsRead?: boolean;
    useEnumeratedValues?: boolean;
    minimum?: bigint;
    maximum?: bigint;
}

interface SvdField {
    name: string;
    bitOffset: number;
    bitWidth: number;
    description?: string;
    access?: string;
    modifiedWriteValues?: string;
    writeConstraint?: SvdWriteConstraint;
    enumValues: SvdEnumValue[];
}

interface SvdRegister {
    id: string;
    peripheral: string;
    name: string;
    address: bigint;
    size: number;
    access?: string;
    readAction?: string;
    modifiedWriteValues?: string;
    writeConstraint?: SvdWriteConstraint;
    description?: string;
    fields: SvdField[];
}

interface SvdPeripheral {
    name: string;
    baseAddress: bigint;
    description?: string;
    registers: SvdRegister[];
}

function toArray<T>(value: T | T[] | undefined): T[] {
    if (value === undefined) {
        return [];
    }

    return Array.isArray(value) ? value : [value];
}

function parseInteger(value: unknown): bigint {
    return BigInt(String(value).trim());
}

function parseOptionalInteger(value: unknown): bigint | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    try {
        return parseInteger(value);
    } catch {
        return undefined;
    }
}


function parseBoolean(value: unknown): boolean | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    const text = String(value).trim().toLowerCase();

    if (text === 'true' || text === '1') {
        return true;
    }

    if (text === 'false' || text === '0') {
        return false;
    }

    return undefined;
}

function parseWriteConstraint(rawConstraint: any): SvdWriteConstraint | undefined {
    if (!rawConstraint) {
        return undefined;
    }

    const range = rawConstraint.range;
    const constraint: SvdWriteConstraint = {
        writeAsRead: parseBoolean(rawConstraint.writeAsRead),
        useEnumeratedValues: parseBoolean(rawConstraint.useEnumeratedValues),
        minimum: parseOptionalInteger(range?.minimum),
        maximum: parseOptionalInteger(range?.maximum)
    };

    if (
        constraint.writeAsRead === undefined &&
        constraint.useEnumeratedValues === undefined &&
        constraint.minimum === undefined &&
        constraint.maximum === undefined
    ) {
        return undefined;
    }

    return constraint;
}

function normalizeModifiedWriteValues(value: unknown): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    const text = String(value).trim();
    return text.length > 0 ? text : undefined;
}

function normalizeWidth(size: number): 8 | 16 | 32 | 64 {
    if (size <= 8) {
        return 8;
    }

    if (size <= 16) {
        return 16;
    }

    if (size <= 32) {
        return 32;
    }

    return 64;
}

function parseField(rawField: any): SvdField | undefined {
    let bitOffset: number | undefined;
    let bitWidth: number | undefined;

    if (rawField.bitOffset !== undefined && rawField.bitWidth !== undefined) {
        bitOffset = Number(rawField.bitOffset);
        bitWidth = Number(rawField.bitWidth);
    } else if (rawField.lsb !== undefined && rawField.msb !== undefined) {
        const lsb = Number(rawField.lsb);
        const msb = Number(rawField.msb);

        bitOffset = lsb;
        bitWidth = msb - lsb + 1;
    } else if (rawField.bitRange !== undefined) {
        const match = String(rawField.bitRange).match(/\[(\d+)\s*:\s*(\d+)\]/);

        if (match) {
            const msb = Number(match[1]);
            const lsb = Number(match[2]);

            bitOffset = lsb;
            bitWidth = msb - lsb + 1;
        }
    }

    if (
        bitOffset === undefined ||
        bitWidth === undefined ||
        !Number.isFinite(bitOffset) ||
        !Number.isFinite(bitWidth) ||
        bitOffset < 0 ||
        bitWidth <= 0
    ) {
        return undefined;
    }

    const enumValues: SvdEnumValue[] = [];

    for (const enumGroup of toArray<any>(rawField.enumeratedValues)) {
        for (const enumValue of toArray<any>(enumGroup?.enumeratedValue)) {
            if (enumValue?.name === undefined || enumValue?.value === undefined) {
                continue;
            }

            const value = parseOptionalInteger(enumValue.value);

            if (value === undefined) {
                // Some SVD files use patterns such as 0b1xx. Skip those for now.
                continue;
            }

            enumValues.push({
                name: String(enumValue.name),
                value,
                description:
                    enumValue.description !== undefined
                        ? String(enumValue.description)
                        : undefined
            });
        }
    }

    return {
        name: String(rawField.name),
        bitOffset,
        bitWidth,
        description:
            rawField.description !== undefined
                ? String(rawField.description)
                : undefined,
        access:
            rawField.access !== undefined
                ? String(rawField.access)
                : undefined,
        modifiedWriteValues: normalizeModifiedWriteValues(
            rawField.modifiedWriteValues
        ),
        writeConstraint: parseWriteConstraint(rawField.writeConstraint),
        enumValues
    };
}

function loadSvd(fileName: string): SvdPeripheral[] {
    const xml = fs.readFileSync(fileName, 'utf8');

    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_'
    });

    const root = parser.parse(xml);
    const device = root.device;

    if (!device) {
        throw new Error('Invalid SVD: <device> not found');
    }

    const rawPeripherals = toArray<any>(device?.peripherals?.peripheral);
    const peripheralMap = new Map<string, any>();

    for (const peripheral of rawPeripherals) {
        peripheralMap.set(String(peripheral.name), peripheral);
    }

    function getRawRegisters(peripheral: any): any[] {
        const ownRegisters = toArray<any>(peripheral?.registers?.register);

        if (ownRegisters.length > 0) {
            return ownRegisters;
        }

        const derivedFrom = peripheral?.['@_derivedFrom'];

        if (derivedFrom !== undefined) {
            const parent = peripheralMap.get(String(derivedFrom));

            if (parent) {
                return getRawRegisters(parent);
            }
        }

        return [];
    }

    const result: SvdPeripheral[] = [];

    for (const rawPeripheral of rawPeripherals) {
        if (rawPeripheral.baseAddress === undefined) {
            continue;
        }

        const peripheralName = String(rawPeripheral.name);
        const baseAddress = parseInteger(rawPeripheral.baseAddress);
        const rawRegisters = getRawRegisters(rawPeripheral);
        const rawRegisterMap = new Map<string, any>();

        for (const rawRegister of rawRegisters) {
            if (rawRegister?.name !== undefined) {
                rawRegisterMap.set(String(rawRegister.name), rawRegister);
            }
        }

        function getRawFields(rawRegister: any, visited = new Set<string>()): any[] {
            const ownFields = toArray<any>(rawRegister?.fields?.field);

            if (ownFields.length > 0) {
                return ownFields;
            }

            const derivedFrom = rawRegister?.['@_derivedFrom'];

            if (derivedFrom === undefined) {
                return [];
            }

            const fullName = String(derivedFrom);
            const registerName = fullName.split('.').pop() ?? fullName;

            if (visited.has(registerName)) {
                return [];
            }

            visited.add(registerName);

            const parentRegister = rawRegisterMap.get(registerName);

            if (!parentRegister) {
                return [];
            }

            return getRawFields(parentRegister, visited);
        }

        const registers: SvdRegister[] = [];

        for (const rawRegister of rawRegisters) {
            if (
                rawRegister?.name === undefined ||
                rawRegister?.addressOffset === undefined
            ) {
                continue;
            }

            const registerName = String(rawRegister.name);
            const offset = parseInteger(rawRegister.addressOffset);
            const size = Number(
                rawRegister.size ??
                rawPeripheral.size ??
                device.size ??
                32
            );

            const fields = getRawFields(rawRegister)
                .map(parseField)
                .filter((field): field is SvdField => field !== undefined)
                .sort((a, b) => a.bitOffset - b.bitOffset);

            registers.push({
                id: `${peripheralName}.${registerName}`,
                peripheral: peripheralName,
                name: registerName,
                address: baseAddress + offset,
                size,
                access:
                    rawRegister.access ??
                    rawPeripheral.access ??
                    device.access,
                readAction:
                    rawRegister.readAction !== undefined
                        ? String(rawRegister.readAction)
                        : undefined,
                modifiedWriteValues: normalizeModifiedWriteValues(
                    rawRegister.modifiedWriteValues
                ),
                writeConstraint: parseWriteConstraint(
                    rawRegister.writeConstraint
                ),
                description:
                    rawRegister.description !== undefined
                        ? String(rawRegister.description)
                        : undefined,
                fields
            });
        }

        registers.sort((a, b) => a.name.localeCompare(b.name));

        result.push({
            name: peripheralName,
            baseAddress,
            description:
                rawPeripheral.description !== undefined
                    ? String(rawPeripheral.description)
                    : undefined,
            registers
        });
    }

    result.sort((a, b) => a.name.localeCompare(b.name));

    return result;
}

/* ========================================================================== */
/*                              OPENOCD TCL RPC                               */
/* ========================================================================== */

class OpenOcdRpc {
    private socket?: net.Socket;
    private rxBuffer = Buffer.alloc(0);
    private connecting?: Promise<void>;

    private host?: string;
    private port?: number;

    private pending: Array<{
        resolve: (response: string) => void;
        reject: (error: Error) => void;
    }> = [];

    configure(host: string, port: number): void {
        const endpointChanged =
            this.host !== host ||
            this.port !== port;

        if (endpointChanged) {
            this.close();
        }

        this.host = host;
        this.port = port;
    }

    clearEndpoint(): void {
        this.close();
        this.host = undefined;
        this.port = undefined;
    }

    isConfigured(): boolean {
        return this.host !== undefined && this.port !== undefined;
    }

    getEndpointText(): string | undefined {
        if (!this.isConfigured()) {
            return undefined;
        }

        return `${this.host}:${this.port}`;
    }

    private async connect(): Promise<void> {
        if (!this.isConfigured()) {
            throw new Error(
                'No Cortex-Debug OpenOCD session is connected. Start Cortex-Debug first.'
            );
        }

        if (this.socket && !this.socket.destroyed) {
            return;
        }

        if (this.connecting) {
            return this.connecting;
        }

        const host = this.host!;
        const port = this.port!;

        this.connecting = new Promise<void>((resolve, reject) => {
            const socket = net.createConnection({
                host,
                port
            });

            const connectError = (error: Error) => {
                socket.destroy();
                this.connecting = undefined;
                reject(error);
            };

            socket.once('error', connectError);

            socket.once('connect', () => {
                socket.removeListener('error', connectError);

                this.socket = socket;
                this.installHandlers(socket);
                this.connecting = undefined;

                resolve();
            });
        });

        return this.connecting;
    }

    private installHandlers(socket: net.Socket): void {
        socket.on('data', (data: Buffer) => {
            this.rxBuffer = Buffer.concat([
                this.rxBuffer,
                data
            ]);

            while (true) {
                const delimiter = this.rxBuffer.indexOf(0x1A);

                if (delimiter < 0) {
                    break;
                }

                const response = this.rxBuffer
                    .subarray(0, delimiter)
                    .toString('utf8')
                    .trim();

                this.rxBuffer = this.rxBuffer.subarray(delimiter + 1);

                const request = this.pending.shift();

                if (request) {
                    request.resolve(response);
                }
            }
        });

        socket.on('close', () => {
            if (this.socket === socket) {
                this.socket = undefined;
            }

            const error = new Error('OpenOCD Tcl connection closed');

            while (this.pending.length > 0) {
                this.pending.shift()!.reject(error);
            }
        });

        socket.on('error', () => {
            // close() handles pending requests.
        });
    }

    async command(command: string): Promise<string> {
        await this.connect();

        return new Promise<string>((resolve, reject) => {
            this.pending.push({
                resolve,
                reject
            });

            this.socket!.write(command + '\x1A', 'utf8');
        });
    }

    close(): void {
        this.connecting = undefined;
        this.rxBuffer = Buffer.alloc(0);

        if (this.socket) {
            this.socket.destroy();
            this.socket = undefined;
        }

        const error = new Error('OpenOCD Tcl connection closed');

        while (this.pending.length > 0) {
            this.pending.shift()!.reject(error);
        }
    }
}

/* ========================================================================== */
/*                               TREE MODEL                                   */
/* ========================================================================== */

type SvdTreeNode =
    | {
        kind: 'watchRoot';
    }
    | {
        kind: 'watchRegister';
        register: SvdRegister;
    }
    | {
        kind: 'peripheral';
        peripheral: SvdPeripheral;
    }
    | {
        kind: 'register';
        register: SvdRegister;
    }
    | {
        kind: 'field';
        register: SvdRegister;
        field: SvdField;
    };

interface LiveState {
    value?: bigint;
    previousValue?: bigint;
    error?: string;
}

class SvdTreeProvider implements vscode.TreeDataProvider<SvdTreeNode> {
    private readonly changed = new vscode.EventEmitter<SvdTreeNode | undefined>();
    readonly onDidChangeTreeData = this.changed.event;

    private peripherals: SvdPeripheral[] = [];
    private registerIndex = new Map<string, SvdRegister>();
    private liveStates = new Map<string, LiveState>();
    private pollInProgress = false;

    constructor(
        private readonly rpc: OpenOcdRpc,
        private readonly onLiveSetChanged: (ids: string[]) => void
    ) {
    }

    setPeripherals(peripherals: SvdPeripheral[]): void {
        this.peripherals = peripherals;
        this.registerIndex.clear();

        for (const peripheral of peripherals) {
            for (const register of peripheral.registers) {
                this.registerIndex.set(register.id, register);
            }
        }

        for (const id of Array.from(this.liveStates.keys())) {
            if (!this.registerIndex.has(id)) {
                this.liveStates.delete(id);
            }
        }

        this.notifyLiveSetChanged();
        this.refresh();
    }

    setLiveRegisterIds(ids: string[]): void {
        this.liveStates.clear();

        for (const id of ids) {
            if (this.registerIndex.has(id)) {
                this.liveStates.set(id, {});
            }
        }

        this.notifyLiveSetChanged();
        this.refresh();
    }

    getLiveRegisterIds(): string[] {
        return Array.from(this.liveStates.keys());
    }

    isLive(id: string): boolean {
        return this.liveStates.has(id);
    }

    enableRegister(register: SvdRegister): void {
        if (this.liveStates.has(register.id)) {
            return;
        }

        this.liveStates.set(register.id, {});
        this.notifyLiveSetChanged();
        this.refresh();
    }

    disableRegister(register: SvdRegister): void {
        if (!this.liveStates.delete(register.id)) {
            return;
        }

        this.notifyLiveSetChanged();
        this.refresh();
    }

    refresh(): void {
        this.changed.fire(undefined);
    }

    private notifyLiveSetChanged(): void {
        this.onLiveSetChanged(this.getLiveRegisterIds());
    }

    getChildren(element?: SvdTreeNode): SvdTreeNode[] {
        if (!element) {
            const roots: SvdTreeNode[] = [];

            if (this.liveStates.size > 0) {
                roots.push({ kind: 'watchRoot' });
            }

            roots.push(
                ...this.peripherals.map(peripheral => ({
                    kind: 'peripheral' as const,
                    peripheral
                }))
            );

            return roots;
        }

        if (element.kind === 'watchRoot') {
            return this.getLiveRegisterIds()
                .map(id => this.registerIndex.get(id))
                .filter((register): register is SvdRegister => register !== undefined)
                .sort((a, b) => a.id.localeCompare(b.id))
                .map(register => ({
                    kind: 'watchRegister' as const,
                    register
                }));
        }

        if (element.kind === 'peripheral') {
            return element.peripheral.registers.map(register => ({
                kind: 'register' as const,
                register
            }));
        }

        if (element.kind === 'register') {
            return element.register.fields.map(field => ({
                kind: 'field' as const,
                register: element.register,
                field
            }));
        }

        return [];
    }

    getTreeItem(element: SvdTreeNode): vscode.TreeItem {
        if (element.kind === 'watchRoot') {
            return this.getWatchRootTreeItem();
        }

        if (element.kind === 'watchRegister') {
            return this.getRegisterTreeItem(element, element.register, true);
        }

        if (element.kind === 'peripheral') {
            return this.getPeripheralTreeItem(element.peripheral);
        }

        if (element.kind === 'register') {
            return this.getRegisterTreeItem(element, element.register, false);
        }

        return this.getFieldTreeItem(element.register, element.field);
    }

    private getWatchRootTreeItem(): vscode.TreeItem {
        const item = new vscode.TreeItem(
            'WATCH',
            vscode.TreeItemCollapsibleState.Expanded
        );

        item.id = 'liveSvd:watchRoot';
        item.contextValue = 'svdWatchRoot';
        item.iconPath = new vscode.ThemeIcon('star-full');
        item.description = `${this.liveStates.size} live`;
        item.tooltip =
            'Live registers selected for this workspace.\n' +
            'The same registers also remain visible inside their peripherals.';

        return item;
    }

    private getPeripheralTreeItem(peripheral: SvdPeripheral): vscode.TreeItem {
        const item = new vscode.TreeItem(
            peripheral.name,
            vscode.TreeItemCollapsibleState.Collapsed
        );

        item.id = `peripheral:${peripheral.name}`;
        item.contextValue = 'svdPeripheral';
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');

        const liveCount = peripheral.registers.reduce(
            (count, register) => count + (this.isLive(register.id) ? 1 : 0),
            0
        );

        if (liveCount > 0) {
            item.description = `${liveCount} live`;
        }

        item.tooltip =
            `${peripheral.name}\n` +
            `Base: 0x${peripheral.baseAddress.toString(16).toUpperCase()}` +
            (peripheral.description ? `\n\n${peripheral.description}` : '');

        return item;
    }

    private getRegisterTreeItem(
        node:
            | Extract<SvdTreeNode, { kind: 'register' }>
            | Extract<SvdTreeNode, { kind: 'watchRegister' }>,
        register: SvdRegister,
        watchCopy: boolean
    ): vscode.TreeItem {
        const hasFields = register.fields.length > 0;

        const item = new vscode.TreeItem(
            watchCopy ? register.id : register.name,
            watchCopy
                ? vscode.TreeItemCollapsibleState.None
                : hasFields
                    ? vscode.TreeItemCollapsibleState.Collapsed
                    : vscode.TreeItemCollapsibleState.None
        );

        item.id = watchCopy
            ? `watch:${register.id}`
            : `register:${register.id}`;

        const state = this.liveStates.get(register.id);

        const writable = canWrite(register.access);

        if (!state) {
            item.contextValue = writable
                ? 'svdRegisterWritable'
                : 'svdRegisterReadonly';
            item.iconPath = new vscode.ThemeIcon('circle-outline');
        } else if (state.error) {
            item.contextValue = writable
                ? 'svdRegisterLiveWritable'
                : 'svdRegisterLiveReadonly';
            item.iconPath = new vscode.ThemeIcon('error');
            item.description = 'ERROR';
        } else if (state.value === undefined) {
            item.contextValue = writable
                ? 'svdRegisterLiveWritable'
                : 'svdRegisterLiveReadonly';
            item.iconPath = new vscode.ThemeIcon('circle-filled');
            item.description = '---';
        } else {
            item.contextValue = writable
                ? 'svdRegisterLiveWritable'
                : 'svdRegisterLiveReadonly';

            const changed =
                state.previousValue !== undefined &&
                state.previousValue !== state.value;

            item.iconPath = new vscode.ThemeIcon(
                changed ? 'pulse' : 'circle-filled'
            );

            item.description = formatRegisterValue(register, state.value);
        }

        item.command = {
            command: 'liveSvd.toggleRegister',
            title: 'Toggle Live Register',
            arguments: [node]
        };

        const address = `0x${register.address.toString(16).toUpperCase()}`;

        item.tooltip =
            (watchCopy ? 'WATCH\n' : '') +
            `${register.id}\n` +
            `Address: ${address}\n` +
            `Size: ${register.size} bit\n` +
            `Access: ${register.access ?? 'unknown'}` +
            (register.modifiedWriteValues
                ? `\nmodifiedWriteValues: ${register.modifiedWriteValues}`
                : '') +
            formatConstraintTooltip(register.writeConstraint) +
            (register.description ? `\n\n${register.description}` : '') +
            (state?.error ? `\n\n${state.error}` : '');

        return item;
    }

    private getFieldTreeItem(register: SvdRegister, field: SvdField): vscode.TreeItem {
        const item = new vscode.TreeItem(
            field.name,
            vscode.TreeItemCollapsibleState.None
        );

        item.id = `field:${register.id}:${field.name}`;
        const effectiveAccess = field.access ?? register.access;
        item.contextValue = canWrite(effectiveAccess)
            ? 'svdFieldWritable'
            : 'svdFieldReadonly';
        item.iconPath = new vscode.ThemeIcon('symbol-field');

        const state = this.liveStates.get(register.id);

        if (state?.value !== undefined && !state.error) {
            const fieldValue = extractFieldValue(state.value, field);
            const enumName = field.enumValues.find(entry => entry.value === fieldValue)?.name;

            if (enumName) {
                item.description = `${fieldValue.toString()} (${enumName})`;
            } else if (field.bitWidth > 4) {
                item.description = `0x${fieldValue.toString(16).toUpperCase()}`;
            } else {
                item.description = fieldValue.toString();
            }
        } else {
            item.description = '---';
        }

        const msb = field.bitOffset + field.bitWidth - 1;

        item.tooltip =
            `${register.id}.${field.name}\n` +
            `Bits: ${msb}:${field.bitOffset}` +
            `\nAccess: ${effectiveAccess ?? 'unknown'}` +
            (field.modifiedWriteValues
                ? `\nmodifiedWriteValues: ${field.modifiedWriteValues}`
                : '') +
            formatConstraintTooltip(field.writeConstraint) +
            (field.description ? `\n\n${field.description}` : '');

        return item;
    }

    private async readRegister(register: SvdRegister): Promise<bigint> {
        const width = normalizeWidth(register.size);
        const address = `0x${register.address.toString(16)}`;

        const response = await this.rpc.command(
            `capture "read_memory ${address} ${width} 1"`
        );

        if (/error|failed|invalid/i.test(response)) {
            throw new Error(response);
        }

        const match = response.match(/0x[0-9a-fA-F]+|\b\d+\b/);

        if (!match) {
            throw new Error(`Unexpected OpenOCD response: "${response}"`);
        }

        return BigInt(match[0]);
    }

    getCachedValue(registerId: string): bigint | undefined {
        return this.liveStates.get(registerId)?.value;
    }

    async readRegisterValue(register: SvdRegister): Promise<bigint> {
        return this.readRegister(register);
    }

    async writeRegisterValue(register: SvdRegister, value: bigint): Promise<void> {
        if (value < 0n) {
            throw new Error('Register value cannot be negative');
        }

        const maxValue = (1n << BigInt(register.size)) - 1n;

        if (value > maxValue) {
            throw new Error(
                `Value does not fit in ${register.size} bits (max 0x${maxValue.toString(16).toUpperCase()})`
            );
        }

        const width = normalizeWidth(register.size);
        const address = `0x${register.address.toString(16)}`;
        const valueText = `0x${value.toString(16)}`;

        const response = await this.rpc.command(
            `write_memory ${address} ${width} {${valueText}}`
        );

        if (/error|failed|invalid/i.test(response)) {
            throw new Error(response);
        }

        const state = this.liveStates.get(register.id);

        if (state) {
            state.previousValue = state.value;
            state.value = value;
            state.error = undefined;
        }

        this.refresh();
    }

    clearLiveValues(): void {
        for (const state of this.liveStates.values()) {
            state.value = undefined;
            state.previousValue = undefined;
            state.error = undefined;
        }

        this.refresh();
    }

    async poll(): Promise<void> {
        if (this.pollInProgress || this.liveStates.size === 0) {
            return;
        }

        this.pollInProgress = true;

        try {
            for (const [id, state] of this.liveStates) {
                const register = this.registerIndex.get(id);

                if (!register) {
                    continue;
                }

                try {
                    const newValue = await this.readRegister(register);

                    state.previousValue = state.value;
                    state.value = newValue;
                    state.error = undefined;
                } catch (error) {
                    state.error =
                        error instanceof Error
                            ? error.message
                            : String(error);
                }
            }

            this.refresh();
        } finally {
            this.pollInProgress = false;
        }
    }
}

function extractFieldValue(registerValue: bigint, field: SvdField): bigint {
    const width = BigInt(field.bitWidth);
    const offset = BigInt(field.bitOffset);
    const mask = (1n << width) - 1n;

    return (registerValue >> offset) & mask;
}

function formatRegisterValue(register: SvdRegister, value: bigint): string {
    const digits = Math.max(1, Math.ceil(register.size / 4));

    return '0x' +
        value
            .toString(16)
            .toUpperCase()
            .padStart(digits, '0');
}

function normalizeAccess(access?: string): string | undefined {
    return access?.trim().toLowerCase();
}

function canRead(access?: string): boolean {
    const normalized = normalizeAccess(access);

    if (!normalized) {
        return true;
    }

    return normalized !== 'write-only' && normalized !== 'writeonce';
}

function canWrite(access?: string): boolean {
    const normalized = normalizeAccess(access);

    if (!normalized) {
        return true;
    }

    return normalized !== 'read-only';
}

function isWriteOnce(access?: string): boolean {
    const normalized = normalizeAccess(access);
    return normalized === 'writeonce' || normalized === 'read-writeonce';
}

function maxValueForBits(bitWidth: number): bigint {
    return (1n << BigInt(bitWidth)) - 1n;
}

function normalizeWriteBehavior(value?: string): string | undefined {
    return value?.trim().toLowerCase();
}

function hasSpecialWriteBehavior(value?: string): boolean {
    const normalized = normalizeWriteBehavior(value);

    return normalized !== undefined && normalized !== 'modify';
}

function effectiveFieldWriteBehavior(
    register: SvdRegister,
    field: SvdField
): string | undefined {
    return field.modifiedWriteValues ?? register.modifiedWriteValues;
}

function registerHasSpecialFieldWriteBehavior(register: SvdRegister): boolean {
    if (hasSpecialWriteBehavior(register.modifiedWriteValues)) {
        return true;
    }

    return register.fields.some(field =>
        hasSpecialWriteBehavior(field.modifiedWriteValues)
    );
}

function registerHasUnreadableWritableField(register: SvdRegister): boolean {
    return register.fields.some(field => {
        const access = field.access ?? register.access;
        return canWrite(access) && !canRead(access);
    });
}

function formatConstraintTooltip(
    constraint?: SvdWriteConstraint
): string {
    if (!constraint) {
        return '';
    }

    const parts: string[] = [];

    if (constraint.minimum !== undefined || constraint.maximum !== undefined) {
        const min = constraint.minimum !== undefined
            ? `0x${constraint.minimum.toString(16).toUpperCase()}`
            : '-inf';
        const max = constraint.maximum !== undefined
            ? `0x${constraint.maximum.toString(16).toUpperCase()}`
            : '+inf';

        parts.push(`range=${min}..${max}`);
    }

    if (constraint.writeAsRead) {
        parts.push('writeAsRead=true');
    }

    if (constraint.useEnumeratedValues) {
        parts.push('useEnumeratedValues=true');
    }

    return parts.length > 0
        ? `\nWrite constraint: ${parts.join(', ')}`
        : '';
}

function validateValueAgainstConstraint(
    value: bigint,
    constraint?: SvdWriteConstraint,
    currentValue?: bigint
): string | undefined {
    if (!constraint) {
        return undefined;
    }

    if (
        constraint.minimum !== undefined &&
        value < constraint.minimum
    ) {
        return `Minimum value is 0x${constraint.minimum.toString(16).toUpperCase()}`;
    }

    if (
        constraint.maximum !== undefined &&
        value > constraint.maximum
    ) {
        return `Maximum value is 0x${constraint.maximum.toString(16).toUpperCase()}`;
    }

    if (
        constraint.writeAsRead &&
        currentValue !== undefined &&
        value !== currentValue
    ) {
        return 'SVD writeConstraint.writeAsRead requires writing the current value unchanged';
    }

    return undefined;
}

async function promptUnsignedValue(
    title: string,
    bitWidth: number,
    currentValue?: bigint,
    constraint?: SvdWriteConstraint
): Promise<bigint | undefined> {
    const bitMaxValue = maxValueForBits(bitWidth);
    const effectiveMin = constraint?.minimum ?? 0n;
    const effectiveMax = constraint?.maximum !== undefined
        ? (constraint.maximum < bitMaxValue ? constraint.maximum : bitMaxValue)
        : bitMaxValue;

    const text = await vscode.window.showInputBox({
        title,
        prompt:
            `Enter 0x${effectiveMin.toString(16).toUpperCase()}..` +
            `0x${effectiveMax.toString(16).toUpperCase()} ` +
            '(decimal, 0xHEX or 0bBINARY)',
        value:
            currentValue !== undefined
                ? `0x${currentValue.toString(16).toUpperCase()}`
                : '',
        validateInput: value => {
            const trimmed = value.trim();

            if (trimmed.length === 0) {
                return 'Enter a value';
            }

            try {
                const parsed = BigInt(trimmed);

                if (parsed < 0n) {
                    return 'Value cannot be negative';
                }

                if (parsed > bitMaxValue) {
                    return `Value does not fit in ${bitWidth} bits`;
                }

                const constraintError = validateValueAgainstConstraint(
                    parsed,
                    constraint,
                    currentValue
                );

                if (constraintError) {
                    return constraintError;
                }
            } catch {
                return 'Use decimal, 0xHEX or 0bBINARY';
            }

            return undefined;
        }
    });

    if (text === undefined) {
        return undefined;
    }

    return BigInt(text.trim());
}

async function promptFieldValue(
    register: SvdRegister,
    field: SvdField,
    currentValue: bigint
): Promise<bigint | undefined> {
    const bitMaxValue = maxValueForBits(field.bitWidth);
    const validEnums = field.enumValues.filter(entry => {
        if (entry.value < 0n || entry.value > bitMaxValue) {
            return false;
        }

        return validateValueAgainstConstraint(
            entry.value,
            field.writeConstraint,
            currentValue
        ) === undefined;
    });

    if (validEnums.length > 0) {
        type EnumPick = vscode.QuickPickItem & {
            value?: bigint;
            numericEntry?: boolean;
        };

        const picks: EnumPick[] = validEnums.map(entry => ({
            label: `${entry.name}`,
            description:
                `0x${entry.value.toString(16).toUpperCase()} ` +
                `(${entry.value.toString()})`,
            detail: entry.description,
            value: entry.value
        }));

        if (!field.writeConstraint?.useEnumeratedValues) {
            picks.push({
                label: '$(edit) Enter numeric value...',
                description: 'decimal, 0xHEX or 0bBINARY',
                numericEntry: true
            });
        }

        const selected = await vscode.window.showQuickPick(
            picks,
            {
                title: `Write ${register.id}.${field.name}`,
                placeHolder:
                    `Current: 0x${currentValue.toString(16).toUpperCase()}`
            }
        );

        if (!selected) {
            return undefined;
        }

        if (!selected.numericEntry) {
            return selected.value;
        }
    } else if (field.writeConstraint?.useEnumeratedValues) {
        void vscode.window.showWarningMessage(
            `${register.id}.${field.name}: SVD requires an enumerated value, ` +
            'but no usable enumerated values were found.'
        );
        return undefined;
    }

    return promptUnsignedValue(
        `Write ${register.id}.${field.name}`,
        field.bitWidth,
        currentValue,
        field.writeConstraint
    );
}

async function confirmSpecialRegisterWrite(register: SvdRegister): Promise<boolean> {
    const warnings: string[] = [];

    if (register.readAction) {
        warnings.push(`readAction=${register.readAction}`);
    }

    if (hasSpecialWriteBehavior(register.modifiedWriteValues)) {
        warnings.push(`modifiedWriteValues=${register.modifiedWriteValues}`);
    }

    if (registerHasSpecialFieldWriteBehavior(register)) {
        warnings.push('one or more fields use special write semantics');
    }

    if (isWriteOnce(register.access)) {
        warnings.push(`access=${register.access}`);
    }

    if (warnings.length === 0) {
        return true;
    }

    const answer = await vscode.window.showWarningMessage(
        `${register.id}: ${warnings.join(', ')}. ` +
        'This is a raw whole-register write. Verify the reference manual before continuing.',
        { modal: true },
        'Write anyway'
    );

    return answer === 'Write anyway';
}

function explainUnsafeFieldRmw(
    register: SvdRegister,
    field: SvdField
): string | undefined {
    if (register.readAction) {
        return `register has readAction=${register.readAction}`;
    }

    const behavior = effectiveFieldWriteBehavior(register, field);

    if (hasSpecialWriteBehavior(behavior)) {
        return `field uses modifiedWriteValues=${behavior}`;
    }

    if (registerHasSpecialFieldWriteBehavior(register)) {
        return 'another field in this register uses special write semantics';
    }

    if (registerHasUnreadableWritableField(register)) {
        return 'the register contains a writable field that cannot be safely read back';
    }

    return undefined;
}

/* ========================================================================== */
/*                               CONFIG                                       */
/* ========================================================================== */

function isCortexDebugOpenOcdSessionForSvd(
    session: vscode.DebugSession | undefined
): session is vscode.DebugSession {
    return (
        session !== undefined &&
        session.type === 'cortex-debug' &&
        session.configuration?.servertype === 'openocd'
    );
}

function getActiveEditorWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        return undefined;
    }

    return vscode.workspace.getWorkspaceFolder(editor.document.uri);
}

function resolveVsCodeVariables(
    value: string,
    folder?: vscode.WorkspaceFolder
): string {
    let result = value;

    if (folder) {
        result = result.replace(
            /\$\{workspaceFolder\}/g,
            folder.uri.fsPath
        );
    }

    result = result.replace(
        /\$\{workspaceFolder:([^}]+)\}/g,
        (match, folderName: string) => {
            const namedFolder = vscode.workspace.workspaceFolders?.find(
                candidate => candidate.name === folderName
            );

            return namedFolder?.uri.fsPath ?? match;
        }
    );

    result = result.replace(
        /\$\{config:([^}]+)\}/g,
        (match, key: string) => {
            const configuration = vscode.workspace.getConfiguration(
                undefined,
                folder?.uri
            );

            const configuredValue = configuration.get<unknown>(key);

            return configuredValue !== undefined
                ? String(configuredValue)
                : match;
        }
    );

    result = result.replace(
        /\$\{env:([^}]+)\}/g,
        (match, key: string) => process.env[key] ?? match
    );

    return result;
}

function makeSvdPath(
    configuredPath: string,
    folder?: vscode.WorkspaceFolder
): string {
    let resolved = resolveVsCodeVariables(configuredPath, folder);

    if (!path.isAbsolute(resolved) && folder) {
        resolved = path.join(folder.uri.fsPath, resolved);
    }

    return path.normalize(resolved);
}

function getFolderSpecificSvdSetting(): {
    folder: vscode.WorkspaceFolder;
    svdFile: string;
} | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const activeEditorFolder = getActiveEditorWorkspaceFolder();

    const orderedFolders = activeEditorFolder
        ? [
            activeEditorFolder,
            ...folders.filter(folder => folder.uri.toString() !== activeEditorFolder.uri.toString())
        ]
        : folders;

    for (const folder of orderedFolders) {
        const inspected = vscode.workspace
            .getConfiguration('liveSvd', folder.uri)
            .inspect<string>('svdFile');

        const folderValue = inspected?.workspaceFolderValue;

        if (typeof folderValue === 'string' && folderValue.length > 0) {
            return {
                folder,
                svdFile: folderValue
            };
        }
    }

    return undefined;
}

function resolveSvdPath(
    preferredSession?: vscode.DebugSession
): string | undefined {
    const session = isCortexDebugOpenOcdSessionForSvd(preferredSession)
        ? preferredSession
        : isCortexDebugOpenOcdSessionForSvd(vscode.debug.activeDebugSession)
            ? vscode.debug.activeDebugSession
            : undefined;

    /*
     * Preferred source: the SVD configured for the active Cortex-Debug
     * session. This is important for multi-root .code-workspace files,
     * because session.workspaceFolder identifies the project that was
     * actually launched.
     */
    if (session) {
        const sessionSvdFile = session.configuration?.svdFile;

        if (typeof sessionSvdFile === 'string' && sessionSvdFile.length > 0) {
            return makeSvdPath(
                sessionSvdFile,
                session.workspaceFolder
            );
        }
    }

    /*
     * Before debug starts, prefer a folder-specific liveSvd.svdFile.
     * In a multi-root workspace this lets every project keep its own
     * .vscode/settings.json.
     */
    const folderSpecific = getFolderSpecificSvdSetting();

    if (folderSpecific) {
        return makeSvdPath(
            folderSpecific.svdFile,
            folderSpecific.folder
        );
    }

    /*
     * Final fallback: workspace/user level setting. Use the active editor's
     * folder as the ${workspaceFolder} base when possible.
     */
    const config = vscode.workspace.getConfiguration('liveSvd');
    const configuredSvdFile = config.get<string>('svdFile');

    if (!configuredSvdFile) {
        return undefined;
    }

    const fallbackFolder =
        getActiveEditorWorkspaceFolder() ??
        vscode.workspace.workspaceFolders?.[0];

    return makeSvdPath(
        configuredSvdFile,
        fallbackFolder
    );
}

/* ========================================================================== */
/*                               EXTENSION                                    */
/* ========================================================================== */

export function activate(context: vscode.ExtensionContext): void {
    const config = vscode.workspace.getConfiguration('liveSvd');

    const host = config.get<string>('openocdHost', '127.0.0.1');
    const refreshMs = config.get<number>('refreshMs', 250);

    const rpc = new OpenOcdRpc();

    let cortexDebugSessionId: string | undefined;
    let cortexDebugConnected = false;

    let savedLiveIds = context.workspaceState.get<string[]>(
        'liveSvd.liveRegisterIds',
        []
    );

    const provider = new SvdTreeProvider(
        rpc,
        ids => {
            savedLiveIds = ids;
            void context.workspaceState.update(
                'liveSvd.liveRegisterIds',
                ids
            );
        }
    );

    const tree = vscode.window.createTreeView(
        'liveSvd.watch',
        {
            treeDataProvider: provider,
            showCollapseAll: true
        }
    );

    context.subscriptions.push(tree);

    let peripherals: SvdPeripheral[] = [];

    function reloadSvd(
        showMessage = true,
        preferredSession?: vscode.DebugSession
    ): void {
        const svdPath = resolveSvdPath(preferredSession);

        if (!svdPath) {
            if (showMessage) {
                void vscode.window.showInformationMessage(
                    'Live SVD: start Cortex-Debug to load the SVD for the selected project.'
                );
            }

            return;
        }

        if (!fs.existsSync(svdPath)) {
            void vscode.window.showErrorMessage(
                `Live SVD: file not found: ${svdPath}`
            );
            return;
        }

        try {
            peripherals = loadSvd(svdPath);
            provider.setPeripherals(peripherals);
            provider.setLiveRegisterIds(savedLiveIds);

            if (showMessage) {
                const registerCount = peripherals.reduce(
                    (sum, peripheral) => sum + peripheral.registers.length,
                    0
                );

                const fieldCount = peripherals.reduce(
                    (sum, peripheral) =>
                        sum + peripheral.registers.reduce(
                            (registerSum, register) =>
                                registerSum + register.fields.length,
                            0
                        ),
                    0
                );

                void vscode.window.showInformationMessage(
                    `Live SVD: loaded ${peripherals.length} peripherals, ` +
                    `${registerCount} registers, ${fieldCount} fields`
                );
            }
        } catch (error) {
            void vscode.window.showErrorMessage(
                'Live SVD: ' +
                (error instanceof Error ? error.message : String(error))
            );
        }
    }

    async function enableWithWarning(register: SvdRegister): Promise<boolean> {
        if (!canRead(register.access)) {
            void vscode.window.showWarningMessage(
                `${register.id} is ${register.access ?? 'not readable'} according to SVD and cannot be polled live.`
            );
            return false;
        }

        if (register.readAction) {
            const answer = await vscode.window.showWarningMessage(
                `${register.id}: readAction=${register.readAction}. ` +
                'Reading this register may have side effects.',
                { modal: true },
                'Add anyway'
            );

            if (answer !== 'Add anyway') {
                return false;
            }
        }

        provider.enableRegister(register);

        if (cortexDebugConnected && rpc.isConfigured()) {
            void provider.poll();
        }

        return true;
    }

    function isCortexDebugOpenOcdSession(session: vscode.DebugSession): boolean {
        return (
            session.type === 'cortex-debug' &&
            session.configuration?.servertype === 'openocd'
        );
    }

    function getTclPortFromArguments(args: any): number | undefined {
        const ports = args?.pvtPorts;

        if (!ports || typeof ports !== 'object') {
            return undefined;
        }

        const value = ports.tclPort;

        if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
            return value;
        }

        if (typeof value === 'string') {
            const parsed = Number(value);

            if (Number.isInteger(parsed) && parsed > 0) {
                return parsed;
            }
        }

        return undefined;
    }

    function getTclPortFromPostStartEvent(
        event: vscode.DebugSessionCustomEvent
    ): number | undefined {
        return getTclPortFromArguments(event.body?.info ?? event.body);
    }

    function sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function connectToCortexDebug(
        session: vscode.DebugSession,
        showFailure = false
    ): Promise<boolean> {
        if (!isCortexDebugOpenOcdSession(session)) {
            return false;
        }

        cortexDebugSessionId = session.id;

        /*
         * Do not depend only on post-start-server. The extension can be
         * activated after that event has already been sent. Cortex-Debug
         * exposes its current ConfigurationArguments through the custom
         * request "get-arguments"; pvtPorts.tclPort is stored there.
         *
         * During very early session startup pvtPorts may not yet be filled,
         * so retry for a few seconds.
         */
        for (let attempt = 0; attempt < 50; attempt++) {
            if (cortexDebugSessionId !== session.id) {
                return false;
            }

            try {
                const args = await session.customRequest('get-arguments');
                const tclPort = getTclPortFromArguments(args);

                if (tclPort !== undefined) {
                    const alreadyConnected =
                        cortexDebugConnected &&
                        rpc.getEndpointText() === `${host}:${tclPort}`;

                    rpc.configure(host, tclPort);
                    cortexDebugConnected = true;

                    if (!alreadyConnected) {
                        provider.clearLiveValues();
                        void provider.poll();

                        void vscode.window.showInformationMessage(
                            `Live SVD: OpenOCD TCL ${host}:${tclPort}`
                        );
                    }

                    return true;
                }
            } catch {
                /* Cortex-Debug may still be starting. Retry below. */
            }

            await sleep(100);
        }

        if (showFailure && cortexDebugSessionId === session.id) {
            void vscode.window.showWarningMessage(
                'Live SVD: could not obtain OpenOCD TCL port from Cortex-Debug.'
            );
        }

        return false;
    }

    function disconnectFromCortexDebug(sessionId?: string): void {
        if (
            sessionId !== undefined &&
            cortexDebugSessionId !== undefined &&
            sessionId !== cortexDebugSessionId
        ) {
            return;
        }

        cortexDebugConnected = false;
        cortexDebugSessionId = undefined;
        rpc.clearEndpoint();
        provider.clearLiveValues();
    }

    context.subscriptions.push(
        vscode.debug.onDidStartDebugSession(session => {
            if (!isCortexDebugOpenOcdSession(session)) {
                return;
            }

            cortexDebugSessionId = session.id;
            cortexDebugConnected = false;
            rpc.clearEndpoint();
            provider.clearLiveValues();

            /*
             * Load the SVD that belongs to the project which actually
             * started this Cortex-Debug session. This fixes multi-root
             * .code-workspace setups where workspaceFolders[0] is another
             * project.
             */
            reloadSvd(false, session);

            /*
             * Main path: ask Cortex-Debug directly for its current arguments.
             * This works even if the post-start-server event is missed.
             */
            void connectToCortexDebug(session, true);
        })
    );

    context.subscriptions.push(
        vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
            if (!isCortexDebugOpenOcdSession(event.session)) {
                return;
            }

            if (event.event !== 'custom-event-post-start-server') {
                return;
            }

            /*
             * Fast path: when the event is received, connect immediately.
             * The direct get-arguments path above remains as a fallback.
             */
            const tclPort = getTclPortFromPostStartEvent(event);

            if (tclPort !== undefined) {
                cortexDebugSessionId = event.session.id;

                const alreadyConnected =
                    cortexDebugConnected &&
                    rpc.getEndpointText() === `${host}:${tclPort}`;

                rpc.configure(host, tclPort);
                cortexDebugConnected = true;

                if (!alreadyConnected) {
                    provider.clearLiveValues();
                    void provider.poll();

                    void vscode.window.showInformationMessage(
                        `Live SVD: OpenOCD TCL ${host}:${tclPort}`
                    );
                }

                return;
            }

            /* If the event body differs, recover through get-arguments. */
            void connectToCortexDebug(event.session, true);
        })
    );

    context.subscriptions.push(
        vscode.debug.onDidTerminateDebugSession(session => {
            if (!isCortexDebugOpenOcdSession(session)) {
                return;
            }

            disconnectFromCortexDebug(session.id);
        })
    );

    /*
     * If Live SVD is activated after Cortex-Debug has already started,
     * recover the dynamic Tcl port instead of waiting for an event that has
     * already happened.
     */
    const activeSession = vscode.debug.activeDebugSession;

    if (activeSession && isCortexDebugOpenOcdSession(activeSession)) {
        cortexDebugSessionId = activeSession.id;
        reloadSvd(false, activeSession);
        void connectToCortexDebug(activeSession, true);
    } else {
        reloadSvd(false);
    }

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'liveSvd.reload',
            () => reloadSvd(true)
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'liveSvd.toggleRegister',
            async (node: SvdTreeNode) => {
                if (
                    !node ||
                    (node.kind !== 'register' && node.kind !== 'watchRegister')
                ) {
                    return;
                }

                const register = node.register;

                if (provider.isLive(register.id)) {
                    provider.disableRegister(register);
                } else {
                    await enableWithWarning(register);
                }
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'liveSvd.addRegister',
            async () => {
                const allRegisters = peripherals.flatMap(
                    peripheral => peripheral.registers
                );

                const availableRegisters = allRegisters.filter(
                    register => !provider.isLive(register.id)
                );

                if (availableRegisters.length === 0) {
                    if (allRegisters.length === 0) {
                        reloadSvd(true);
                    } else {
                        void vscode.window.showInformationMessage(
                            'Live SVD: all available registers are already live'
                        );
                    }

                    return;
                }

                const selected = await vscode.window.showQuickPick(
                    availableRegisters.map(register => ({
                        label: register.id,
                        description:
                            '0x' + register.address.toString(16).toUpperCase(),
                        detail:
                            `${register.size} bit, ` +
                            `${register.access ?? 'unknown access'}`,
                        register
                    })),
                    {
                        placeHolder: 'Select SVD register',
                        matchOnDescription: true,
                        matchOnDetail: true
                    }
                );

                if (!selected) {
                    return;
                }

                await enableWithWarning(selected.register);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'liveSvd.removeRegister',
            (node: SvdTreeNode) => {
                if (
                    !node ||
                    (node.kind !== 'register' && node.kind !== 'watchRegister')
                ) {
                    return;
                }

                provider.disableRegister(node.register);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'liveSvd.writeRegister',
            async (node: SvdTreeNode) => {
                if (
                    !node ||
                    (node.kind !== 'register' && node.kind !== 'watchRegister')
                ) {
                    return;
                }

                const register = node.register;

                if (!cortexDebugConnected || !rpc.isConfigured()) {
                    void vscode.window.showWarningMessage(
                        'Live SVD: start a Cortex-Debug OpenOCD session first.'
                    );
                    return;
                }

                if (!canWrite(register.access)) {
                    void vscode.window.showWarningMessage(
                        `${register.id} is read-only according to SVD`
                    );
                    return;
                }

                let currentValue = provider.getCachedValue(register.id);

                if (
                    currentValue === undefined &&
                    canRead(register.access) &&
                    !register.readAction
                ) {
                    try {
                        currentValue = await provider.readRegisterValue(register);
                    } catch {
                        // The user can still perform an explicit raw write.
                    }
                }

                const value = await promptUnsignedValue(
                    `Write ${register.id}`,
                    register.size,
                    currentValue,
                    register.writeConstraint
                );

                if (value === undefined) {
                    return;
                }

                const constraintError = validateValueAgainstConstraint(
                    value,
                    register.writeConstraint,
                    currentValue
                );

                if (constraintError) {
                    void vscode.window.showWarningMessage(
                        `${register.id}: ${constraintError}`
                    );
                    return;
                }

                if (!await confirmSpecialRegisterWrite(register)) {
                    return;
                }

                try {
                    await provider.writeRegisterValue(register, value);
                    void provider.poll();
                } catch (error) {
                    void vscode.window.showErrorMessage(
                        `Live SVD: write ${register.id} failed: ` +
                        (error instanceof Error ? error.message : String(error))
                    );
                }
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'liveSvd.writeField',
            async (node: SvdTreeNode) => {
                if (!node || node.kind !== 'field') {
                    return;
                }

                const register = node.register;
                const field = node.field;

                if (!cortexDebugConnected || !rpc.isConfigured()) {
                    void vscode.window.showWarningMessage(
                        'Live SVD: start a Cortex-Debug OpenOCD session first.'
                    );
                    return;
                }

                const effectiveAccess = field.access ?? register.access;

                if (!canWrite(effectiveAccess)) {
                    void vscode.window.showWarningMessage(
                        `${register.id}.${field.name} is read-only according to SVD`
                    );
                    return;
                }

                if (!canRead(register.access)) {
                    void vscode.window.showWarningMessage(
                        `${register.id} is write-only. Safe field editing requires read-modify-write.`
                    );
                    return;
                }

                const unsafeReason = explainUnsafeFieldRmw(register, field);

                if (unsafeReason) {
                    void vscode.window.showWarningMessage(
                        `${register.id}.${field.name}: safe field editing is disabled because ${unsafeReason}. ` +
                        'Use whole-register write only after checking the reference manual.'
                    );
                    return;
                }

                if (isWriteOnce(effectiveAccess)) {
                    const answer = await vscode.window.showWarningMessage(
                        `${register.id}.${field.name} has access=${effectiveAccess}. ` +
                        'The debugger cannot know whether firmware already performed the one allowed write after reset.',
                        { modal: true },
                        'Continue'
                    );

                    if (answer !== 'Continue') {
                        return;
                    }
                }

                try {
                    const registerValue = await provider.readRegisterValue(register);
                    const currentFieldValue = extractFieldValue(registerValue, field);

                    const fieldValue = await promptFieldValue(
                        register,
                        field,
                        currentFieldValue
                    );

                    if (fieldValue === undefined) {
                        return;
                    }

                    const constraintError = validateValueAgainstConstraint(
                        fieldValue,
                        field.writeConstraint,
                        currentFieldValue
                    );

                    if (constraintError) {
                        void vscode.window.showWarningMessage(
                            `${register.id}.${field.name}: ${constraintError}`
                        );
                        return;
                    }

                    const shiftedMask =
                        maxValueForBits(field.bitWidth) << BigInt(field.bitOffset);

                    const newRegisterValue =
                        (registerValue & ~shiftedMask) |
                        ((fieldValue << BigInt(field.bitOffset)) & shiftedMask);

                    await provider.writeRegisterValue(register, newRegisterValue);
                    void provider.poll();
                } catch (error) {
                    void vscode.window.showErrorMessage(
                        `Live SVD: write ${register.id}.${field.name} failed: ` +
                        (error instanceof Error ? error.message : String(error))
                    );
                }
            }
        )
    );

    const timer = setInterval(
        () => {
            if (cortexDebugConnected && rpc.isConfigured()) {
                void provider.poll();
            }
        },
        refreshMs
    );

    context.subscriptions.push({
        dispose: () => {
            clearInterval(timer);
            rpc.close();
        }
    });
}

export function deactivate(): void {
}
