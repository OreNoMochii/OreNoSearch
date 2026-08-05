import fs from 'fs';
import path from 'path';

const STATE_FILE = path.join(__dirname, '../../.metaview_state.json');

interface StateSchema {
    expandedChats: Record<string, number>;
    extractedChats: string[];
    generatedRoles: string[];
}

class StateManager {
    private state: StateSchema = {
        expandedChats: {},
        extractedChats: [],
        generatedRoles: []
    };

    /** Membership index over extractedChats. The array grows without bound
     *  across runs, and hasExtracted is called once per sidebar chat. */
    private extractedIndex = new Set<string>();

    /** Set while a debounced write is pending, so a burst of updates costs one
     *  file write rather than one per update. */
    private flushTimer: NodeJS.Timeout | null = null;

    constructor() {
        this.load();
        this.extractedIndex = new Set(this.state.extractedChats);
    }

    private load() {
        if (fs.existsSync(STATE_FILE)) {
            try {
                const data = fs.readFileSync(STATE_FILE, 'utf-8');
                this.state = JSON.parse(data);
                // Schema validation fallback
                if (!this.state.expandedChats) this.state.expandedChats = {};
                if (!this.state.extractedChats) this.state.extractedChats = [];
                if (!this.state.generatedRoles) this.state.generatedRoles = [];
            } catch (e) {
                console.error('Failed to load state, starting fresh.');
            }
        }
    }

    /**
     * Persists state, coalescing bursts.
     *
     * Every recordExtraction / recordExpansion / recordRoleSearch used to
     * rewrite the whole file synchronously, pretty-printed. During a scrape
     * those arrive in bursts, so the process blocked on disk repeatedly to
     * write a file whose final contents are the only ones that matter.
     *
     * flushNow() exists so a caller can force the write before exit.
     */
    private save() {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.writeState();
        }, 250);
        // Do not hold the process open purely for a pending state write.
        this.flushTimer.unref();
    }

    private writeState() {
        try {
            fs.writeFileSync(STATE_FILE, JSON.stringify(this.state));
        } catch (e) {
            console.error('Failed to persist state:', e);
        }
    }

    /** Writes any pending state immediately. Call before a deliberate exit. */
    flushNow() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.writeState();
    }

    // Role tracking
    hasRoleBeenSearched(role: string): boolean {
        return this.state.generatedRoles.some(r => r.toLowerCase() === role.toLowerCase());
    }

    recordRoleSearch(role: string) {
        this.state.generatedRoles.push(role);
        this.save();
    }

    // Chat expansion tracking
    canExpand(chatId: string, maxExpansions: number = 2): boolean {
        const count = this.state.expandedChats[chatId] || 0;
        return count < maxExpansions;
    }

    recordExpansion(chatId: string) {
        const count = this.state.expandedChats[chatId] || 0;
        this.state.expandedChats[chatId] = count + 1;
        this.save();
    }

    // Candidate Extraction tracking
    hasExtracted(chatId: string): boolean {
        return this.extractedIndex.has(chatId);
    }

    recordExtraction(chatId: string) {
        if (this.extractedIndex.has(chatId)) return;
        this.extractedIndex.add(chatId);
        this.state.extractedChats.push(chatId);
        this.save();
    }

    getExpandedIds(maxExpansions: number = 2): string[] {
        return Object.entries(this.state.expandedChats)
            .filter(([id, count]) => count >= maxExpansions)
            .map(([id]) => id);
    }

    getExtractedIds(): string[] {
        return [...this.state.extractedChats];
    }
}

export const stateManager = new StateManager();
