package dev.afkdesk.diagnostics;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.fluid.FluidState;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;

public final class AfkDeskMovementDiagnostics implements ClientModInitializer {
    private static final Gson GSON = new Gson();
    private static final int FLUSH_EVERY_TICKS = 20;
    private static final int BLOCK_SNAPSHOT_INTERVAL_TICKS = 20;
    private BufferedWriter writer;
    private long lastTickNanos;
    private long tick;

    @Override
    public void onInitializeClient() {
        ClientTickEvents.END_CLIENT_TICK.register(this::captureVanillaMovement);
        Runtime.getRuntime().addShutdownHook(new Thread(this::closeWriter, "afkdesk-diagnostics-close"));
    }

    private void captureVanillaMovement(MinecraftClient client) {
        ClientPlayerEntity player = client.player;
        if (player == null || client.world == null) return;

        long now = System.nanoTime();
        JsonObject sample = new JsonObject();
        sample.addProperty("timestamp", Instant.now().toString());
        sample.addProperty("tick", ++tick);
        sample.addProperty("tickIntervalMs", lastTickNanos == 0 ? 0 : (now - lastTickNanos) / 1_000_000.0);
        lastTickNanos = now;
        sample.addProperty("dimension", client.world.getRegistryKey().getValue().toString());
        sample.add("position", vector(player.getX(), player.getY(), player.getZ()));
        sample.add("velocity", vector(player.getVelocity()));
        sample.addProperty("yaw", player.getYaw());
        sample.addProperty("pitch", player.getPitch());
        sample.addProperty("touchingWater", player.isTouchingWater());
        sample.addProperty("submergedInWater", player.isSubmergedInWater());
        sample.addProperty("onGround", player.isOnGround());
        sample.addProperty("horizontalCollision", player.horizontalCollision);
        sample.addProperty("fluidHeight", player.getFluidHeight(FluidTags.WATER));
        if (tick % BLOCK_SNAPSHOT_INTERVAL_TICKS == 0) {
            sample.add("nearbyBlocks", nearbyBlocks(client, player.getBlockPos()));
        }

        try {
            writer().write(GSON.toJson(sample));
            writer.write(System.lineSeparator());
            if (tick % FLUSH_EVERY_TICKS == 0) writer.flush();
        } catch (IOException error) {
            closeWriter();
        }
    }

    private JsonArray nearbyBlocks(MinecraftClient client, BlockPos center) {
        JsonArray blocks = new JsonArray();
        for (int y = -1; y <= 2; y++) {
            for (int z = -1; z <= 1; z++) {
                for (int x = -1; x <= 1; x++) {
                    BlockPos pos = center.add(x, y, z);
                    BlockState block = client.world.getBlockState(pos);
                    FluidState fluid = client.world.getFluidState(pos);
                    if (block.isAir() && fluid.isEmpty()) continue;
                    JsonObject entry = new JsonObject();
                    entry.addProperty("x", pos.getX());
                    entry.addProperty("y", pos.getY());
                    entry.addProperty("z", pos.getZ());
                    entry.addProperty("block", Registries.BLOCK.getId(block.getBlock()).toString());
                    entry.addProperty("blockState", block.toString());
                    entry.addProperty("fluid", Registries.FLUID.getId(fluid.getFluid()).toString());
                    entry.addProperty("fluidHeight", fluid.isEmpty() ? 0 : fluid.getHeight(client.world, pos));
                    blocks.add(entry);
                }
            }
        }
        return blocks;
    }

    private JsonObject vector(Vec3d value) {
        return vector(value.x, value.y, value.z);
    }

    private JsonObject vector(double x, double y, double z) {
        JsonObject result = new JsonObject();
        result.addProperty("x", x);
        result.addProperty("y", y);
        result.addProperty("z", z);
        return result;
    }

    private BufferedWriter writer() throws IOException {
        if (writer != null) return writer;
        Path logs = FabricLoader.getInstance().getGameDir().resolve("logs");
        Files.createDirectories(logs);
        Path output = logs.resolve("afkdesk-vanilla-movement.jsonl");
        writer = Files.newBufferedWriter(output, StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        return writer;
    }

    private synchronized void closeWriter() {
        if (writer == null) return;
        try { writer.close(); } catch (IOException ignored) {}
        writer = null;
    }
}
