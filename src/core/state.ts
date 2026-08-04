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

    constructor() {
        this.load();
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

    private save() {
        fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
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
        return this.state.extractedChats.includes(chatId);
    }

    recordExtraction(chatId: string) {
        if (!this.hasExtracted(chatId)) {
            this.state.extractedChats.push(chatId);
            this.save();
        }
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
