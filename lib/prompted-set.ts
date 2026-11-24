/**
 * 已提示集合：session 内同资产至多提示一次（与 read 与否无关）。
 * FIFO 上限防涨；session 内存态，重启重置。
 */
const CAP = 64;

export class PromptedSet {
	private set = new Set<string>();
	private order: string[] = [];

	has(entry: string): boolean {
		return this.set.has(entry);
	}

	add(entry: string): void {
		this.set.add(entry);
		this.order.push(entry);
		while (this.order.length > CAP) {
			const oldest = this.order.shift();
			if (oldest != null) this.set.delete(oldest);
		}
	}

	get size(): number {
		return this.set.size;
	}
}
