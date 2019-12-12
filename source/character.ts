import { Queue } from "prioqueue"
import { IEntity, IPosition, ItemName, ItemInfo, SlotType, ICharacter, MonsterType, IPositionReal, NPCName } from './definitions/adventureland';
import { Pathfinder } from './pathfinder';
import { sendMassCM, findItems, getInventory, getRandomMonsterSpawnPosition, getAttackingEntities, getCooldownMS, isAvailable, canSeePlayer } from "./functions";
import { TargetPriorityList, OtherInfo, MyItemInfo } from "./definitions/bots";

export abstract class Character {
    /**
     * A list of monsters, ranked from highest priority to lowest priority.
     */
    // protected abstract targetPriority: MonsterName[];
    public abstract targetPriority: TargetPriorityList;
    protected abstract mainTarget: MonsterType;
    public movementQueue: IPosition[] = [];
    public holdPosition = false;
    public holdAttack = false;
    protected pathfinder: Pathfinder = new Pathfinder(6);
    protected partyInfo: any = {};
    protected otherInfo: OtherInfo = {
        "npcs": {},
        "players": {}
    };
    // protected chests = new Set<string>()

    protected mainLoop() {
        // Equip better items if we have one in our inventory
        if (parent.character.ctype !== "merchant") {
            this.equipBetterItems()
            this.getMonsterhuntQuest()
        }

        this.getNewYearTreeBuff()

        this.loot()

        setTimeout(() => { this.mainLoop(); }, Math.max(250, parent.character.ping))
    }

    public run() {
        this.healLoop()
        this.attackLoop()
        this.scareLoop()
        this.moveLoop()
        this.sendInfoLoop()
        this.mainLoop()
    }

    /**
     * Sends a bunch of CMs to players in our party list telling them information like what quest we have, what items we have, etc.
     *
     * @protected
     * @memberof Character
     */
    protected sendInfoLoop() {
        try {
            let message: any;

            // Chests
            let chests = [];
            let i = 0;
            for (let chestID in parent.chests) {
                chests.push(chestID);
                if (++i > 50) break;
            }
            if (i > 0) {
                message = {
                    "message": "chests",
                    "chests": chests
                }
                sendMassCM(parent.party_list, message)
                this.parse_cm(parent.character.name, message)
            }

            // Information about us
            message = {
                "message": "info",
                "info": {
                    "canMonsterHunt": this.canMonsterHunt(),
                    "inventory": getInventory(),
                    "map": parent.character.map,
                    "x": parent.character.real_x,
                    "y": parent.character.real_y,
                    "s": parent.character.s
                }
            }
            sendMassCM(parent.party_list, message)
            this.parse_cm(parent.character.name, message)

            // Other players
            for (let id in parent.entities) {
                if (parent.entities[id].type != "character") continue;
                if (parent.entities[id].npc) continue;

                let player = parent.entities[id] as ICharacter
                message = {
                    "message": "player",
                    "id": id,
                    "info": {
                        "lastSeen": new Date(),
                        "rip": player.rip,
                        "map": player.map,
                        "x": player.real_x,
                        "y": player.real_y,
                        "s": player.s,
                        "ctype": player.ctype
                    }
                }

                sendMassCM(parent.party_list, message)
                this.parse_cm(parent.character.name, message)
            }

            // Important NPCs
            for (let npc of ["Angel", "Kane"]) {
                if (!parent.entities[npc]) continue;
                message = {
                    "message": "npc",
                    "id": npc,
                    "info": {
                        "lastSeen": new Date(),
                        "map": parent.entities[npc].map,
                        "x": parent.entities[npc].real_x,
                        "y": parent.entities[npc].real_y
                    }
                }
                if (parent.entities[npc]) {
                    sendMassCM(parent.party_list, message)
                    this.parse_cm(parent.character.name, message)
                }
            }

            setTimeout(() => { this.sendInfoLoop() }, 5000)
        } catch (error) {
            console.error(error)
            setTimeout(() => { this.sendInfoLoop() }, 5000)
        }
    }

    public canMonsterHunt() {
        if (parent.character.ctype == "merchant") return false; // Merchant's can't do monster hunts
        if (!parent.character.s.monsterhunt) return true; // No monster hunt
        if (this.targetPriority[parent.character.s.monsterhunt.id]) return true; // Monster hunt target is in our target list

        for (let id of parent.party_list) {
            let member = this.partyInfo[id]
            if (!member.s || !member.s.monsterhunt) continue;
            if (this.targetPriority[member.s.monsterhunt.id as MonsterType]) return true; // We can do a party member's monster hunt
        }

        return false;
    }

    protected loot() {
        let i = 0;
        for (let chestID in parent.chests) {
            let chest = parent.chests[chestID]
            if (distance(parent.character, chest) < 800) parent.socket.emit("open_chest", { id: chestID }) // It's 800 as per @Wizard in #feedback on 11/26/2019
            if (++i > 20) break
        }
    }

    protected attackLoop(): void {
        try {
            let targets = this.getTargets(1)
            if (targets.length == 0 // No targets
                || parent.character.stoned // Can't attack
                || parent.character.mp < parent.character.mp_cost // No MP
                || !isAvailable("attack") // On cooldown
                || distance(parent.character, targets[0]) > parent.character.range
                || (smart.moving && this.targetPriority[targets[0].mtype] && this.targetPriority[targets[0].mtype].holdAttack && targets[0].target != parent.character.name) // Holding attack and not being attacked
                || (this.holdAttack && targets[0].target != parent.character.name)) { // Holding attack and not being attacked
                setTimeout(() => { this.attackLoop() }, Math.max(50, getCooldownMS("attack")))
            } else {
                attack(targets[0]).then(() => {
                    // Attack success!
                    // TODO: I don't remember why we do this. I don't think we need to do this.
                    this.getTargets(1); // Get a new target right away
                    setTimeout(() => { this.attackLoop() }, getCooldownMS("attack"))
                }, () => {
                    // Attack fail...
                    setTimeout(() => { this.attackLoop() }, getCooldownMS("attack"))
                });
            }
        } catch (error) {
            console.error(error)
            setTimeout(() => { this.attackLoop() }, getCooldownMS("attack"))
        }
    }

    protected scareLoop(): void {
        try {
            let targets = getAttackingEntities()
            let wantToScare = false
            for (let target of targets) {
                if (target.attack * 2 > parent.character.hp // 2 attacks and we're dead.
                    || targets.length >= 3 // We are scared and our attack is lowered
                    || !this.targetPriority[target.mtype]) { // Not in our target priority
                    wantToScare = true
                    break
                }
            }
            if (!isAvailable("scare") // On cooldown
                || parent.character.mp < 50 // No MP
                || !wantToScare) { // Can't be easily killed
                setTimeout(() => { this.scareLoop() }, Math.max(parent.character.ping, getCooldownMS("scare")));
                return;
            }


            if (parent.character.slots.orb.name == "jacko") {
                // We have a jacko equipped
                use_skill("scare")
            } else {
                // We have a jacko in our inventory
                // TODO: Sometimes the orb doesn't get re-equipped...
                let items = findItems("jacko")
                if (items.length) {
                    let jackoI = items[0].index
                    equip(jackoI) // Equip the jacko
                    use_skill("scare") // Scare the monsters away
                }
            }
        } catch (error) {
            console.error(error);
        }
        setTimeout(() => { this.scareLoop() }, Math.max(parent.character.ping, getCooldownMS("scare")));
    }

    protected moveLoop(): void {
        try {
            let targets = this.getTargets(1);
            if (this.holdPosition || smart.moving) {
                if (targets.length > 0 /* We have a target in range */
                    && this.targetPriority[targets[0].mtype] && this.targetPriority[targets[0].mtype].stopOnSight /* We stop on sight of that target */
                    && this.pathfinder.movementTarget == targets[0].mtype /* We're moving to that target */
                    && distance(parent.character, targets[0]) < parent.character.range /* We're in range of that target */) {
                    stop();
                    this.movementQueue = []; // clear movement queue
                }

                // Don't move, we're holding position or smart moving somewhere
                setTimeout(() => { this.moveLoop() }, 250); // TODO: move this 250 cooldown to a setting.
                return;
            } else if (this.movementQueue.length == 0) { // No movements queued
                // Reset movement target
                let movementTarget = this.getMovementTarget()
                if (movementTarget) {
                    this.pathfinder.saferMove(movementTarget)
                }

                // Default movements
                if (["ranger", "mage", "priest"].includes(parent.character.ctype)) {
                    this.avoidAggroMonsters();
                }

                this.avoidAttackingMonsters();

                if (["ranger", "mage", "warrior", "priest"].includes(parent.character.ctype)) {
                    this.moveToMonster();
                }
            } else {
                // Pathfinding movements
                // TODO: we need to pop our movement somewhere
                let currentMovement = this.movementQueue[0];
                let nextMovement = this.movementQueue[0]
                if (this.movementQueue.length > 1) {
                    nextMovement = this.movementQueue[1];
                }
                if (can_move_to(nextMovement.x, nextMovement.y)) {
                    // We can move to the next place in the queue, so let's start moving there.
                    move(nextMovement.x, nextMovement.y)
                    this.movementQueue.shift();
                } else if (!parent.character.moving && can_move_to(currentMovement.x, currentMovement.y)) {
                    move(currentMovement.x, currentMovement.y)
                } else {
                    // We can't move to the next place in the queue...
                    // TODO: Pathfind to the next place in the queue
                }
            }

            setTimeout(() => { this.moveLoop() }, Math.max(250, parent.character.ping)); // TODO: queue up next movement based on time it will take to walk there
        } catch (error) {
            console.error(error)
            setTimeout(() => { this.moveLoop() }, 250);
        }
    }

    protected healLoop(): void {
        try {
            if (parent.character.rip) {
                // Respawn if we're dead
                respawn();
                setTimeout(() => { this.healLoop() }, Math.max(getCooldownMS("use_town"), parent.character.ping)) // TODO: Find out something that tells us how long we have to wait before respawning.
                return;
            } else if (!isAvailable("use_hp")) {
                setTimeout(() => { this.healLoop() }, getCooldownMS("use_hp"))
                return;
            }

            let hpPots: ItemName[] = ["hpot0", "hpot1"]
            let mpPots: ItemName[] = ["mpot0", "mpot1"]
            let useMpPot: ItemInfo = null
            let useHpPot: ItemInfo = null

            // TODO: find last potion in inventory
            for (let i = parent.character.items.length - 1; i >= 0; i--) {
                let item = parent.character.items[i];
                if (!item) continue;

                if (!useHpPot && hpPots.includes(item.name)) {
                    // This is the HP Pot that will be used
                    useHpPot = item
                } else if (!useMpPot && mpPots.includes(item.name)) {
                    // This is the MP Pot that will be used
                    useMpPot = item
                }

                if (useHpPot && useMpPot) {
                    // We've found the last two pots we're using
                    break
                }
            }

            let hp_ratio = parent.character.hp / parent.character.max_hp
            let mp_ratio = parent.character.mp / parent.character.max_mp
            if (hp_ratio <= mp_ratio
                && hp_ratio != 1
                && (!useHpPot
                    || (useHpPot.name == "hpot0" && (parent.character.hp <= parent.character.max_hp - 200 || parent.character.hp < 50))
                    || (useHpPot.name == "hpot1" && (parent.character.hp <= parent.character.max_hp - 400 || parent.character.hp < 50)))) {
                use_skill("use_hp")
            } else if (mp_ratio != 1
                && (!useMpPot
                    || (useMpPot.name == "mpot0" && (parent.character.mp <= parent.character.max_mp - 300 || parent.character.mp < 50))
                    || (useMpPot.name == "mpot1" && (parent.character.mp <= parent.character.max_mp - 500 || parent.character.mp < 50)))) {
                use_skill("use_mp")
            }

            setTimeout(() => { this.healLoop() }, Math.max(250, getCooldownMS("use_hp")))
        } catch (error) {
            console.error(error)
            setTimeout(() => { this.healLoop() }, Math.max(250, getCooldownMS("use_hp")))
        }
    }

    protected avoidAggroMonsters(): void {
        let closeEntity: IEntity = null;
        let moveDistance = 0;
        for (let id in parent.entities) {
            let entity = parent.entities[id];
            if (entity.type != "monster") continue; // Not a monster
            if (entity.aggro == 0) continue; // Not an aggressive monster
            if (entity.target && entity.target != parent.character.name) continue; // Targeting someone else
            let d = Math.max(60, entity.speed * 1.5) - distance(parent.character, entity);
            if (d < 0) continue; // Far away

            if (d > moveDistance) {
                closeEntity = entity;
                moveDistance = d;
            }
        }

        if (!closeEntity) return; // No close monsters

        let escapePosition: IPosition;
        let angle = Math.atan2(parent.character.real_y - closeEntity.real_y, parent.character.real_x - closeEntity.real_x);
        let x = Math.cos(angle) * moveDistance
        let y = Math.sin(angle) * moveDistance
        escapePosition = { x: parent.character.real_x + x, y: parent.character.real_y + y };

        if (can_move_to(escapePosition.x, escapePosition.y)) {
            move(escapePosition.x, escapePosition.y)
        } else {
            // TODO: Pathfind there, and take the first movement.
        }
    }

    protected avoidAttackingMonsters(): void {
        // Find all monsters attacking us
        let attackingMonsters: IEntity[] = [];
        for (let id in parent.entities) {
            let potentialTarget = parent.entities[id];
            if (potentialTarget.target != parent.character.name) continue; // Not targeting us

            attackingMonsters.push(potentialTarget);
        }
        let currentTarget = get_targeted_monster();
        if (currentTarget) {
            attackingMonsters.push(currentTarget);
        }

        if (!attackingMonsters) return; // There aren't any monsters attacking us

        // Find the closest monster of those attacking us
        let minDistance = 0;
        let escapePosition: IPosition;
        let minTarget: IEntity = null;
        for (let target of attackingMonsters) {
            let d = distance(parent.character, target);
            if (target.speed > parent.character.speed) continue; // We can't outrun it, don't try
            if (d > (target.range + (target.speed + parent.character.speed) * Math.max(parent.character.ping * 0.001, 0.5))) continue; // We're still far enough away to not get attacked
            if (target.hp < parent.character.attack * 0.7 * 0.9 * damage_multiplier(target.armor - parent.character.apiercing)) continue // We can kill it in one shot, don't move.
            if (d < minDistance) continue; // There's another target that's closer
            if (target.range > parent.character.range) continue; // We can't attack it by kiting, don't try
            minDistance = d;
            minTarget = target;
        }

        if (!minTarget) return; // We're far enough away not to get attacked, or it's impossible to do so

        // Move away from the closest monster
        let angle: number = Math.atan2(parent.character.real_y - minTarget.real_y, parent.character.real_x - minTarget.real_x);
        let moveDistance: number = minTarget.range + minTarget.speed - (minDistance / 2)
        function calculateEscape(angle: number, move_distance: number): IPosition {
            let x = Math.cos(angle) * move_distance
            let y = Math.sin(angle) * move_distance
            return { x: parent.character.real_x + x, y: parent.character.real_y + y };
        }
        escapePosition = calculateEscape(angle, moveDistance);
        let angleChange: number = 0;
        while (!can_move_to(escapePosition.x, escapePosition.y) && angleChange < 180) {
            if (angleChange <= 0) {
                angleChange = (-angleChange) + 1;
            } else {
                angleChange = -angleChange;
            }
            escapePosition = calculateEscape(angle + (angleChange * Math.PI / 180), moveDistance)
            // game_log("angle: " + (angle + (angleChange * Math.PI / 180)) + "x: " + escapePosition.x + ", y: " + escapePosition.y)
        }

        if (can_move_to(escapePosition.x, escapePosition.y)) {
            // game_log("escaping from monster");
            move(escapePosition.x, escapePosition.y)
        } else {
            // TODO: Pathfind there, and take the first movement.
        }
    }

    public moveToMonster(): void {
        let targets = this.getTargets(1);
        if (targets.length == 0 // There aren't any targets to move to
            || (this.targetPriority[targets[0].mtype] && this.targetPriority[targets[0].mtype].holdPosition) // We don't want to move to these monsters
            || distance(parent.character, targets[0]) <= parent.character.range) // We have a target, and it's in range.
            return;

        if (can_move_to(targets[0].real_x, targets[0].real_y)) {
            let moveDistance = distance(parent.character, targets[0]) - parent.character.range + (targets[0].speed * 0.5)
            let angle: number = Math.atan2(targets[0].real_y - parent.character.real_y, targets[0].real_x - parent.character.real_x);
            let x = Math.cos(angle) * moveDistance
            let y = Math.sin(angle) * moveDistance

            // Move normally to target
            // game_log("moving normally to target")
            move(parent.character.real_x + x, parent.character.real_y + y);
        } else {
            try {
                // Pathfind to target
                // game_log("pathfinding to target")
                let path = this.pathfinder.findNextMovement(parent.character, targets[0]);
                // TODO: check if we have a path
                move(path.x, path.y);
            } catch (error) {
                // Our custom pathfinding failed, use the game's smart move.
                // game_log("smart moving to target")
                xmove(targets[0].real_x, targets[0].real_y);
            }
        }
    }

    public getNewYearTreeBuff() {
        if (!G.maps.main.ref.newyear_tree) return; // Event is not live.
        if (parent.character.s.holidayspirit) return; // We already have the buff.
        if (distance(parent.character, G.maps.main.ref.newyear_tree) > 250) return; // Too far away

        parent.socket.emit("interaction", { type: "newyear_tree" });
    }

    public getMonsterhuntQuest() {
        let monsterhunter: IPosition = { map: "main", x: 126, y: -413 }
        if (distance(parent.character, monsterhunter) > 250) return; // Too far away
        if (!parent.character.s.monsterhunt) {
            // No quest, get a new one
            parent.socket.emit('monsterhunt')
        } else if (parent.character.s.monsterhunt.c == 0) {
            // We've finished a quest
            parent.socket.emit('monsterhunt')
        }
    }

    public parse_cm(characterName: string, data: any) {
        if (!parent.party_list.includes(characterName) && parent.character.name !== characterName) {
            // Ignore messages from players not in our party
            game_log("Blocked CM from " + characterName);
            return;
        }

        // Start tracking info for this player if we haven't yet
        if (!this.partyInfo[characterName]) this.partyInfo[characterName] = {}

        if (data.message == "info") {
            this.partyInfo[characterName] = data.info
        } else if (data.message == "npc") {
            this.otherInfo.npcs[data.id as NPCName] = data.info
        } else if (data.message == "player") {
            this.otherInfo.players[data.id] = data.info
        }
    }

    /**
     * Looks if we have items in our inventory that are the same as those equipped, only a higher level.
     */
    public equipBetterItems() {
        let items = getInventory();

        for (let slot in parent.character.slots) {
            let slotItem: ItemInfo = parent.character.slots[slot as SlotType];
            let betterItem: MyItemInfo
            if (!slotItem) continue; // Nothing equipped in that slot
            for (let item of items) {
                if (item.name !== slotItem.name) continue; // Not the same item
                if (item.level <= slotItem.level) continue; // Not better than the currently equipped item

                // We found something better
                slotItem = item;
                betterItem = item; // Overwrite the slot info, and keep looking
            }

            // Equip our better item
            if (betterItem) equip(betterItem.index, slot as SlotType);
        }
    }

    public getMovementTarget(): IPositionReal {
        // Check for golden bat
        for (let id in parent.entities) {
            let entity = parent.entities[id]
            if (entity.mtype == "goldenbat") {
                set_message("goldenbat")
                this.pathfinder.movementTarget = "goldenbat";
                // NOTE: We should pathfind to it on our own
                // TODO: make sure we actually do this, lol
                return
            }
        }

        // Check for Christmas Tree
        if (G.maps.main.ref.newyear_tree && !parent.character.s.holidayspirit) {
            this.pathfinder.movementTarget = "newyear_tree";
            return G.maps.main.ref.newyear_tree
        }

        // Check for event monsters
        for (let name in parent.S) {
            if (this.targetPriority[name as MonsterType]) {
                set_message(name)
                this.pathfinder.movementTarget = name;
                for (let id in parent.entities) {
                    let entity = parent.entities[id]
                    if (entity.mtype == name) {
                        // There's one nearby
                        return;
                    }
                }
                return parent.S[name as MonsterType]
            }
        }

        // Check if our inventory is full
        let full = true;
        for (let i = 0; i < 42; i++) {
            if (!parent.character.items[i]) {
                full = false;
                break;
            }
        }
        if (full) {
            // This is where our merchant usually hangs out
            return { map: "main", "x": 60, "y": -325 }
        }

        // Check for monster hunt
        if (!parent.character.s.monsterhunt) {
            set_message("New MH")
            this.pathfinder.movementTarget = "monsterhunter";
            return G.maps.main.ref.monsterhunter
        } else if (parent.character.s.monsterhunt.c == 0) {
            set_message("Finish MH")
            this.pathfinder.movementTarget = "monsterhunter";
            return G.maps.main.ref.monsterhunter
        } else {
            // Get all party quests
            let potentialTargets: MonsterType[] = [parent.character.s.monsterhunt.id]
            for (let info in this.partyInfo) {
                if (!this.partyInfo[info].s.monsterhunt) continue; // They don't have a monster hunt
                if (this.partyInfo[info].s.monsterhunt.c == 0) continue; // They're turning it in
                potentialTargets.push(this.partyInfo[info].s.monsterhunt.id as MonsterType)
            }
            for (let potentialTarget of potentialTargets) {
                if (this.targetPriority[potentialTarget]) {

                    // We have a doable quest
                    set_message("MH " + potentialTarget.slice(0, 8))
                    this.pathfinder.movementTarget = potentialTarget;
                    for (let id in parent.entities) {
                        let entity = parent.entities[id]
                        if (entity.mtype == potentialTarget) {
                            // There's one nearby
                            return;
                        }
                    }
                    // We aren't near the monster hunt target, move to it
                    if (this.targetPriority[potentialTarget].map && this.targetPriority[potentialTarget].x && this.targetPriority[potentialTarget].y) {
                        return this.targetPriority[potentialTarget] as IPositionReal
                    } else {
                        return getRandomMonsterSpawnPosition(potentialTarget)
                    }
                }
            }
        }

        // Check if we can farm with +1000% luck (and maybe +1000% gold, too!)
        let kane = parent.entities.Kane ? parent.entities.Kane : this.otherInfo.npcs.Kane
        let angel = parent.entities.Angel ? parent.entities.Angel : this.otherInfo.npcs.Angel
        if (kane && angel) {
            if (canSeePlayer("Kane") && canSeePlayer("Angel")) {
                // We're near both of them
                set_message("2x1000% farm")
                this.pathfinder.movementTarget = undefined;
                return;
            } else if (distance(kane, angel) < 800) {
                // Kane and Angel are close to each other, try to farm both!
                return { "map": kane.map, "x": (kane.x + angel.x) / 2, "y": (kane.y + angel.y) / 2 }
            }

            if (canSeePlayer("Kane")) {
                set_message("1000% luck")
                this.pathfinder.movementTarget = undefined
                return // We're near Kane
            } else {
                this.pathfinder.movementTarget = undefined
                set_message("1000% luck")
                return kane
            }
        }

        // Check for our main target
        set_message(this.mainTarget)
        this.pathfinder.movementTarget = this.mainTarget;
        for (let id in parent.entities) {
            let entity = parent.entities[id]
            if (entity.mtype == this.mainTarget) {
                // There's one nearby
                return;
            }
        }
        if (this.targetPriority[this.mainTarget].map && this.targetPriority[this.mainTarget].x && this.targetPriority[this.mainTarget].y) {
            return this.targetPriority[this.mainTarget] as IPositionReal
        } else {
            return getRandomMonsterSpawnPosition(this.mainTarget)
        }

    }

    public getTargets(numTargets: number = 1): IEntity[] {
        let targets: IEntity[] = [];

        // Find out what targets are already claimed by our party members
        let members = parent.party_list;
        let claimedTargets: string[] = []
        for (let id in parent.entities) {
            if (members.includes(id)) {
                let target = parent.entities[id].target;
                if (target) claimedTargets.push(target)
            }
        }

        let potentialTargets = new Queue<IEntity>((x, y) => x.priority - y.priority);
        for (let id in parent.entities) {
            let potentialTarget = parent.entities[id];
            let d = distance(parent.character, potentialTarget);
            if (!this.targetPriority[potentialTarget.mtype] && potentialTarget.target != parent.character.name) continue; // Not a monster we care about, and it's not attacking us
            if (potentialTarget.type != "monster") // Not a monster
                if (!is_pvp() && potentialTarget.type == "character") continue; // Not PVP

            // Set a priority based on the index of the entity 
            let priority = 0;
            if (this.targetPriority[potentialTarget.mtype]) priority = this.targetPriority[potentialTarget.mtype].priority;

            // Adjust priority if a party member is already attacking it and it has low HP
            if (claimedTargets.includes(id) && potentialTarget.hp <= parent.character.attack) priority -= 250;

            // Increase priority if it's our "main target"
            if (potentialTarget.mtype == this.mainTarget) priority += 10;

            // Increase priority if it's our movement target
            if (potentialTarget.mtype == this.pathfinder.movementTarget) priority += 500;

            // Increase priority if the entity is targeting us
            if (potentialTarget.target == parent.character.name) priority += 1000;

            // Adjust priority based on distance
            priority -= d;

            // Adjust priority based on remaining HP
            // priority -= potentialTarget.hp

            potentialTargets.enqueue(priority, potentialTarget);
        }

        if (potentialTargets.size == 0) {
            // No potential targets
            return targets;
        }

        while (targets.length < numTargets && potentialTargets.size > 0) {
            targets.push(potentialTargets.dequeue().value)
        }
        // if (this.movementTarget == newTarget.mtype) {
        //     // We've reached the monster we want to reach, so let's stop moving.
        //     this.movementTarget = null;
        //     this.movementQueue = [];
        // }
        if (targets.length > 0)
            change_target(targets[0])
        return targets;
    }
}