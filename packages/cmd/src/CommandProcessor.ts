/*
* This program and the accompanying materials are made available under the terms of the *
* Eclipse Public License v2.0 which accompanies this distribution, and is available at *
* https://www.eclipse.org/legal/epl-v20.html                                      *
*                                                                                 *
* SPDX-License-Identifier: EPL-2.0                                                *
*                                                                                 *
* Copyright Contributors to the Zowe Project.                                     *
*                                                                                 *
*/

import { ICommandDefinition } from "./doc/ICommandDefinition";
import { Arguments } from "yargs";
import { ICommandValidatorResponse } from "./doc/response/response/ICommandValidatorResponse";
import { ICommandHandler } from "./doc/handler/ICommandHandler";
import { couldNotInstatiateCommandHandler, unexpectedCommandError } from "../../messages";
import { SharedOptions } from "./utils/SharedOptions";
import { ImperativeError, IImperativeError } from "../../error";
import { IProfileManagerFactory } from "../../profiles";
import { SyntaxValidator } from "./syntax/SyntaxValidator";
import { CommandProfileLoader } from "./profiles/CommandProfileLoader";
import { ICommandProfileTypeConfiguration } from "./doc/profiles/definition/ICommandProfileTypeConfiguration";
import { IHelpGeneratorFactory } from "./help/doc/IHelpGeneratorFactory";
import { IHelpGenerator } from "./help/doc/IHelpGenerator";
import { ICommandPrepared } from "./doc/response/response/ICommandPrepared";
import { CommandResponse } from "./response/CommandResponse";
import { ICommandResponse } from "./doc/response/response/ICommandResponse";
import { Logger } from "../../logger";
import { IInvokeCommandParms } from "./doc/parms/IInvokeCommandParms";
import { ICommandProcessorParms } from "./doc/processor/ICommandProcessorParms";
import { ImperativeExpect } from "../../expect";
import { inspect } from "util";
import { TextUtils } from "../../utilities";
import * as nodePath from "path";
import { ICommandHandlerRequire } from "./doc/handler/ICommandHandlerRequire";
import { ChainedHandlerService } from "./ChainedHandlerUtils";
import { Constants } from "../../constants";
import { ICommandOutputFormat, OUTPUT_FORMAT } from "./doc/response/response/ICommandOutputFormat";
import { CommandUtils } from "..";

/**
 * The command processor for imperative - accepts the command definition for the command being issued (and a pre-built)
 * response object and validates syntax, loads profiles, instantiates handlers, & invokes the handlers.
 * @export
 * @class CommandProcessor
 */
export class CommandProcessor {
    /**
     * The error tag for imperative errors.
     * @private
     * @static
     * @type {string}
     * @memberof CommandProcessor
     */
    private static readonly ERROR_TAG: string = "Command Processor Error:";
    /**
     * The root command name of the CLI (specified in the Imperative Configuration document)
     * @private
     * @type {string}
     * @memberof CommandProcessor
     */
    private mCommandRootName: string;
    /**
     * The command definition node for the command being executed.
     * @private
     * @type {ICommandDefinition}
     * @memberof CommandProcessor
     */
    private mDefinition: ICommandDefinition;
    /**
     * The full command definition contains all parents/anscestors of the command being executed.
     * @private
     * @type {ICommandDefinition}
     * @memberof CommandProcessor
     */
    private mFullDefinition: ICommandDefinition;
    /**
     * The help generator to use - normally passed the default generator.
     * @private
     * @type {IHelpGenerator}
     * @memberof CommandProcessor
     */
    private mHelpGenerator: IHelpGenerator;
    /**
     * The profile manager to use when loading profiles for commands
     * @private
     * @type {IProfileManagerFactory<ICommandProfileTypeConfiguration>}
     * @memberof CommandProcessor
     */
    private mProfileManagerFactory: IProfileManagerFactory<ICommandProfileTypeConfiguration>;
    /**
     * Imperative Logger instance for logging from the command processor.
     * @private
     * @type {Logger}
     * @memberof CommandProcessor
     */
    private mLogger: Logger = Logger.getImperativeLogger();

    /**
     * Creates an instance of CommandProcessor.
     * @param {ICommandProcessorParms} params - See the interface for details.
     * @memberof CommandProcessor
     */
    constructor(params: ICommandProcessorParms) {
        ImperativeExpect.toNotBeNullOrUndefined(params, `${CommandProcessor.ERROR_TAG} No parameters supplied to constructor.`);
        this.mDefinition = params.definition;
        ImperativeExpect.toNotBeNullOrUndefined(this.mDefinition, `${CommandProcessor.ERROR_TAG} No command definition supplied.`);
        this.mFullDefinition = (params.fullDefinition == null) ? this.mDefinition : params.fullDefinition;
        this.mHelpGenerator = params.helpGenerator;
        ImperativeExpect.toNotBeNullOrUndefined(this.mHelpGenerator, `${CommandProcessor.ERROR_TAG} No help generator supplied.`);
        this.mProfileManagerFactory = params.profileManagerFactory;
        ImperativeExpect.toNotBeNullOrUndefined(this.mProfileManagerFactory, `${CommandProcessor.ERROR_TAG} No profile manager factory supplied.`);
        if (this.mDefinition.type === "command" && this.mDefinition.chainedHandlers == null) {
            ImperativeExpect.keysToBeDefinedAndNonBlank(this.mDefinition, ["handler"], `${CommandProcessor.ERROR_TAG} ` +
                `The definition supplied is of type "command", ` +
                `but no handler was specified.`);
        }
        this.mCommandRootName = params.rootCommandName;
        ImperativeExpect.keysToBeDefinedAndNonBlank(params, ["rootCommandName"], `${CommandProcessor.ERROR_TAG} No root command supplied.`);
        // TODO - check if the command definition passed actually exists within the full command definition tree passed
    }

    /**
     * Accessor for the root command name
     * @readonly
     * @type {string}
     * @memberof CommandProcessor
     */
    get rootCommand(): string {
        return this.mCommandRootName;
    }

    /**
     * Accessor for the help generator passed to this instance of the command processor
     * @readonly
     * @type {IHelpGeneratorFactory}
     * @memberof CommandProcessor
     */
    get helpGenerator(): IHelpGenerator {
        return this.mHelpGenerator;
    }

    /**
     * Accessor for the profile manager factory in use for this command processor.
     * @readonly
     * @type {IProfileManagerFactory<ICommandProfileTypeConfiguration>}
     * @memberof CommandProcessor
     */
    get profileFactory(): IProfileManagerFactory<ICommandProfileTypeConfiguration> {
        return this.mProfileManagerFactory;
    }

    /**
     * Obtain a copy of the command definition
     * @return {ICommandDefinition}: The Bright Commands definition document.
     */
    get definition(): ICommandDefinition {
        return JSON.parse(JSON.stringify(this.mDefinition));
    }

    /**
     * Obtain a copy of the command definition
     * @return {ICommandDefinition}: The Bright Commands definition document.
     */
    get fullDefinition(): ICommandDefinition {
        return JSON.parse(JSON.stringify(this.mFullDefinition));
    }

    /**
     * Generates the help for the command definition passed.
     * @param {CommandResponse} response - The command resposne object
     * @memberof CommandProcessor
     */
    public help(response: CommandResponse): ICommandResponse {
        ImperativeExpect.toNotBeNullOrUndefined(response, `${CommandProcessor.ERROR_TAG} help(): No command response object supplied.`);
        this.log.info(`Building help text for command "${this.definition.name}"...`);
        const help: string = this.helpGenerator.buildHelp();
        response.data.setObj(help);
        response.console.log(Buffer.from(help));
        response.data.setMessage(`The help was constructed for command: ${this.mDefinition.name}.`);
        return this.finishResponse(response);
    }

    /**
     * Validates the input arguments/options for the command (Performs additional validation outside of what Yargs
     * already provides - ideally, we would like to maintain control over all errors and messages for consistency).
     * @param {yargs.Argv} commandArguments: The input command arguments from the command line.
     * @param {CommandResponse} responseObject: Response object to print.
     * @return {Promise<ICommandValidatorResponse>}: Promise to be fulfilled when validation is complete.
     */
    public async validate(commandArguments: Arguments, responseObject: CommandResponse): Promise<ICommandValidatorResponse> {
        ImperativeExpect.toNotBeNullOrUndefined(commandArguments, `${CommandProcessor.ERROR_TAG} validate(): No command arguments supplied.`);
        ImperativeExpect.toNotBeNullOrUndefined(responseObject, `${CommandProcessor.ERROR_TAG} validate(): No response object supplied.`);
        this.log.info(`Performing syntax validation for command "${this.definition.name}"...`);
        return new SyntaxValidator(this.mDefinition, this.mFullDefinition).validate(responseObject, commandArguments);
    }

    /**
     * Invoke the command handler. Locates and requires the module specified by the command definition document,
     * creates a new object, creates a response object, and invokes the handler. The handler is responsible for
     * fulfilling the promise when complete.
     * @param {params} IInvokeCommandParms
     * @return {Promise<ICommandResponse>} - The promise that is fulfilled. A rejection if the promise indicates a
     * truly exceptional condition (should not occur).
     */
    public async invoke(params: IInvokeCommandParms): Promise<ICommandResponse> {
        // Ensure parameters are correct
        ImperativeExpect.toNotBeNullOrUndefined(params,
            `${CommandProcessor.ERROR_TAG} invoke(): No parameters supplied.`);
        ImperativeExpect.toNotBeNullOrUndefined(params.arguments,
            `${CommandProcessor.ERROR_TAG} invoke(): No command arguments supplied.`);
        params.responseFormat = (params.responseFormat == null) ? "default" : params.responseFormat;
        const responseOptions: string[] = ["default", "json"];
        ImperativeExpect.toBeOneOf(params.responseFormat, responseOptions,
            `${CommandProcessor.ERROR_TAG} invoke(): Response format must be one of the following: ${responseOptions.join(",")}`);
        ImperativeExpect.toBeAnArray(params.arguments._,
            `${CommandProcessor.ERROR_TAG} invoke(): The command arguments object supplied does not contain an array of args.`);
        if (this.definition.chainedHandlers == null) {
            ImperativeExpect.toNotBeNullOrUndefined(this.definition.handler,
                `${CommandProcessor.ERROR_TAG} invoke(): Cannot invoke the command "${this.definition.name}"` +
                `. It has no handler and no chained handlers.`);
            ImperativeExpect.toNotBeEqual(this.definition.handler.trim(), "",
                `${CommandProcessor.ERROR_TAG} invoke(): Cannot invoke the handler for command "${this.definition.name}". The handler is blank.`);
        }

        // Log the invoke
        this.log.info(`Invoking command "${this.definition.name}"...`);
        this.log.trace(`Arguments supplied for for the command:\n${TextUtils.prettyJson(params.arguments)}`);
        this.log.trace(`Command definition:\n${inspect(this.definition, { depth: null })}`);
        this.log.trace(`Invoke parameters:\n${inspect(params, { depth: null })}`);

        // Build the response object
        const response = this.constructResponseObject(params);

        // Assume that the command succeed, it will be marked otherwise under the appropriate failure conditions
        response.succeeded();

        // Validate that the syntax is correct for the command
        let validator: ICommandValidatorResponse;
        try {
            validator = await this.validate(params.arguments, response);
        } catch (e) {
            const errMsg: string = `Unexpected syntax validation error`;
            const errReason: string = errMsg + ": " + e.message;
            this.log.error(`Validation for command "${this.definition.name}" has failed unexpectedly: ${errReason}`);
            response.data.setMessage(errReason);
            response.console.errorHeader(errMsg);
            response.console.error(e.message);
            response.setError({
                msg: errMsg,
                additionalDetails: e.message,
            });
            response.failed();
            return this.finishResponse(response);
        }

        // Check if the syntax is valid - if not return immediately.
        if (!validator.valid) {
            this.log.error(`Syntax for command "${this.definition.name}" is invalid.`);
            response.data.setMessage("Command syntax invalid");
            response.failed();
            let finalHelp: string;
            if (params.arguments._.length > 0) {
                finalHelp = `\nUse "${this.rootCommand} ${params.arguments._.join(" ")} --help" to view command description, usage, and options.`;
            } else {
                finalHelp = `\nUse "${this.definition.name} --help" to view command description, usage, and options.`;
            }
            response.console.error(finalHelp);
            return this.finishResponse(response);
        }

        // Prepare for command processing - load profiles, stdin, etc.
        let prepared: ICommandPrepared;
        try {
            this.log.info(`Preparing (loading profiles, reading stdin, etc.) execution of "${this.definition.name}" command...`);
            prepared = await this.prepare(response, params.arguments);
        } catch (prepareErr) {

            // Indicate that the command has failed
            response.failed();

            // Construct the main error header/message
            const err: string = `${prepareErr.message || "Internal Error: No cause message present."}`;
            this.log.error(err);
            response.data.setMessage(err);
            response.console.errorHeader("Command Preparation Failed");
            response.console.error(err);

            // Start constructing the error object for the response
            const impErr: IImperativeError = {
                msg: err
            };

            // If details are present and of type "string", output the additional details
            if ((prepareErr as ImperativeError).details.additionalDetails != null
                && typeof (prepareErr as ImperativeError).details.additionalDetails === "string") {
                response.console.errorHeader("Error Details");
                response.console.error((prepareErr as ImperativeError).details.additionalDetails);
                impErr.additionalDetails = (prepareErr as ImperativeError).details.additionalDetails;
            }

            // Set the error response object and finish the command response
            response.setError(impErr);
            return this.finishResponse(response);
        }

        // Invoke the handler

        this.log.info(`Invoking process method of handler for "${this.definition.name}" command.`);


        if (this.definition.handler != null) {
            // single handler - no chained handlers
            const handler: ICommandHandler = this.attemptHandlerLoad(response, this.definition.handler);
            if (handler == null) {
                // if the handler load failed
                return this.finishResponse(response);
            }

            try {
                await handler.process({
                    response,
                    profiles: prepared.profiles,
                    arguments: params.arguments,
                    definition: this.definition,
                    fullDefinition: this.fullDefinition
                });
            }
            catch (processErr) {
                this.handleHandlerError(processErr, response, this.definition.handler);

                // Return the failed response to the caller
                return this.finishResponse(response);
            }

            this.log.info(`Handler for command "${this.definition.name}" succeeded.`);
            response.succeeded();
            response.endProgressBar();

            // Return the response to the caller
            return this.finishResponse(response);

        } else if (this.definition.chainedHandlers != null) {
            // chained handlers - no single handler
            const chainedResponses: any[] = [];

            let chainedResponse: CommandResponse;

            let bufferedStdOut = Buffer.from([]);
            let bufferedStdErr = Buffer.from([]);
            this.log.debug("Attempting to invoke %d chained handlers for command: '%s'", this.definition.chainedHandlers.length,
                this.definition.name);
            for (let chainedHandlerIndex = 0; chainedHandlerIndex < this.definition.chainedHandlers.length; chainedHandlerIndex++) {
                const chainedHandler = this.definition.chainedHandlers[chainedHandlerIndex];
                this.log.debug("Loading chained handler '%s' (%d of %d)",
                    chainedHandler.handler, chainedHandlerIndex + 1, this.definition.chainedHandlers.length);
                const handler: ICommandHandler = this.attemptHandlerLoad(response, chainedHandler.handler);
                if (handler == null) {
                    // if the handler load failed
                    this.log.fatal("failed to load a chained handler! aborting chained handler sequence.");
                    return this.finishResponse(response);
                }
                this.log.debug("Constructing new response object for handler '%s': silent?: %s. json?: %s",
                    chainedHandler.handler, chainedHandler.silent + "", params.arguments[Constants.JSON_OPTION] + "");
                chainedResponse = this.constructResponseObject({
                    arguments: params.arguments,
                    silent: chainedHandler.silent,
                    responseFormat: params.arguments[Constants.JSON_OPTION] ? "json" : "default"
                });

                // make sure the new chained response preserves output
                chainedResponse.bufferStdout(bufferedStdOut);
                chainedResponse.bufferStderr(bufferedStdErr);
                try {
                    await handler.process({
                        response: chainedResponse,
                        profiles: prepared.profiles,
                        arguments: ChainedHandlerService.getArguments(
                            this.mCommandRootName,
                            this.definition.chainedHandlers,
                            chainedHandlerIndex,
                            chainedResponses,
                            params.arguments,
                            this.log
                        ),
                        definition: this.definition,
                        fullDefinition: this.fullDefinition,
                        isChained: true
                    });
                    const builtResponse = chainedResponse.buildJsonResponse();
                    chainedResponses.push(builtResponse.data);
                    // save the stdout and stderr to pass to the next chained handler (if any)
                    bufferedStdOut = builtResponse.stdout;
                    bufferedStdErr = builtResponse.stderr;

                } catch (processErr) {
                    this.handleHandlerError(processErr, chainedResponse, chainedHandler.handler);

                    // Return the failed response to the caller
                    return this.finishResponse(chainedResponse);
                }
            }

            this.log.info(`Chained handlers for command "${this.definition.name}" succeeded.`);
            response.succeeded();
            response.endProgressBar();

            // Return the response to the caller
            return this.finishResponse(chainedResponse);
        }


    }

    /**
     * Prepare for command execution. Actions such as reading stdin, auto-loading profiles, etc. will occur here before
     * the command handler is invoked.
     * @param {CommandResponse} response: The response object for command messaging.
     * @param {yargs.Arguments} commandArguments: The arguments specified on the command line.
     * @return {Promise<CommandResponse>}: Promise to fulfill when complete.
     */
    private async prepare(response: CommandResponse, commandArguments: Arguments): Promise<ICommandPrepared> {
        this.log.trace(`Reading stdin for "${this.definition.name}" command...`);
        await SharedOptions.readStdinIfRequested(commandArguments, response, this.definition.type);
        this.log.trace(`Loading profiles for "${this.definition.name}" command. ` +
            `Profile definitions: ${inspect(this.definition.profile, { depth: null })}`);
        const profiles = await CommandProfileLoader.loader({
            commandDefinition: this.definition,
            profileManagerFactory: this.profileFactory
        }).loadProfiles(commandArguments);
        this.log.trace(`Profiles loaded for "${this.definition.name}" command:\n${inspect(profiles, { depth: null })}`);
        return { profiles };
    }

    /**
     * Internal accessor for the logger instance.
     * @readonly
     * @private
     * @type {Logger}
     * @memberof CommandProcessor
     */
    private get log(): Logger {
        return this.mLogger;
    }

    /**
     * Build the response object for the command based on the invoke parameters. The command response object is
     * passed to the handlers to allow them to perform console messages, response JSON construction, progress bars, etc.
     * @private
     * @param {IInvokeCommandParms} params
     * @returns {CommandResponse}
     * @memberof CommandProcessor
     */
    private constructResponseObject(params: IInvokeCommandParms): CommandResponse {
        this.log.trace(`Constructing response object for "${this.definition.name}" command...`);
        return new CommandResponse({
            definition: this.definition,
            args: params.arguments,
            silent: (params.silent == null) ? false : params.silent,
            responseFormat: params.responseFormat
        });
    }

    /**
     * Attempt to load a handler
     * @param {CommandResponse} response - command response to use to log errors in case of failure
     * @param {string} handlerPath - the specified path to the handler, we will attempt to load this
     * @returns {ICommandHandler}
     */
    private attemptHandlerLoad(response: CommandResponse, handlerPath: string): ICommandHandler {
        try {
            this.log.info(`Requiring handler "${handlerPath}" for command "${handlerPath}"...`);
            const commandHandler: ICommandHandlerRequire = require(handlerPath);
            const handler = new commandHandler.default();
            this.log.info(`Handler "${handlerPath}" for command "${this.definition.name}" successfully loaded/required.`);
            return handler;
        } catch (handlerErr) {
            this.log.error(`Failed to load/require handler "${handlerPath}" for command "${this.definition.name}".`);
            this.log.error(`Error details: ${handlerErr.message}`);
            const errorMessage: string = TextUtils.formatMessage(couldNotInstatiateCommandHandler.message, {
                commandHandler: nodePath.normalize(handlerPath) || "\"undefined or not specified\"",
                definitionName: this.definition.name
            });
            response.failed();
            response.console.errorHeader("Handler Instantiation Failed");
            response.console.error(errorMessage);
            response.data.setMessage(errorMessage);
            response.console.errorHeader("Error Details");
            response.console.error(handlerErr.message);
            response.setError({
                msg: errorMessage,
                additionalDetails: handlerErr.message
            });
            return undefined;
        }
    }

    /**
     * Finish the response by building the response object and optionally outputting the JSON response depending on the
     * modes selected.
     * @private
     * @param {CommandResponse} response
     * @returns {ICommandResponse}
     * @memberof CommandProcessor
     */
    private finishResponse(response: CommandResponse): ICommandResponse {
        const json: ICommandResponse = response.buildJsonResponse();
        if (!response.silent) {
            switch (response.responseFormat) {
                case "json":
                    response.writeJsonResponse();
                    break;
                case "default":
                    // Do nothing - already written along the way
                    break;
                default:
                    throw new ImperativeError({
                        msg: `${CommandProcessor.ERROR_TAG} ` +
                            `The response format specified ("${response.responseFormat}") is not valid.`
                    });
            }
        }
        this.log.info(`Command "${this.definition.name}" completed with success flag: "${json.success}"`);
        this.log.trace(`Command "${this.definition.name}" finished. Response object:\n${inspect(json, { depth: null })}`);
        return json;
    }

    /**
     * Respond to an error encountered when invoking a command handler
     * @param {Error} handlerErr - the error that was encountered
     * @param {CommandResponse} response - a response object to print error messages to
     * @param {string}  handlerPath - path to the handler with which an error was encountered
     */
    private handleHandlerError(handlerErr: Error, response: CommandResponse, handlerPath: string): void {
        // Mark the command as failed
        this.log.error(`Handler for command "${this.definition.name}" failed.`);
        response.failed();
        response.endProgressBar();

        // If this is an instance of an imperative error, then we are good to go and can formulate the response.
        // If it is an Error object, then something truly unexpected occurred in the handler.
        // If there is no error response (or something else), then the command was rejected with the reject method.
        if (handlerErr instanceof ImperativeError) {
            this.log.error(`Handler for ${this.mDefinition.name} rejected by thrown ImperativeError.`);
            response.setError(handlerErr.details);
            response.console.errorHeader("Command Error");
            response.console.error(Buffer.from(handlerErr.message + "\n"));
            if ((handlerErr as ImperativeError).details.additionalDetails != null
                && typeof (handlerErr as ImperativeError).details.additionalDetails === "string") {
                response.console.errorHeader("Error Details");
                response.console.error((handlerErr as ImperativeError).details.additionalDetails);
            }
            response.data.setMessage(handlerErr.message);
        } else if (handlerErr instanceof Error) {
            this.log.error(`Handler for ${this.mDefinition.name} rejected by unhandled exception.`);
            response.setError({ msg: handlerErr.message, stack: handlerErr.stack });
            response.data.setMessage(unexpectedCommandError.message + ": " + handlerErr.message);
            this.log.error(`An error was thrown during command execution of "${this.definition.name}". Error Details: ${handlerErr.message}`);
            response.console.errorHeader(unexpectedCommandError.message);
            response.console.error(`Please review the message and stack below.\n` +
                `Contact the creator of handler:\n` +
                `"${handlerPath}"`);

            // Print the message if present
            response.console.errorHeader("Message");
            if (handlerErr.message) {
                response.console.error(handlerErr.message);
            } else {
                response.console.error("No message present in the error.");
            }

            // Print the stack if present
            response.console.errorHeader("Stack");
            if (handlerErr.stack) {
                response.console.error(handlerErr.stack);
            } else {
                response.console.error("No error stack present in the error.");
            }
        } else if (typeof handlerErr === "string") {
            this.log.error(`The handler rejected (or threw an error) and the response was of type string: ${handlerErr}`);
            response.console.errorHeader("Command Error");
            response.console.error(handlerErr);
            response.data.setMessage(handlerErr);
            response.setError({ msg: handlerErr });
        } else if (handlerErr == null) {
            this.log.error("The handler rejected the promise with no message or error.");
            response.data.setMessage("Command failed");
            response.setError({ msg: "Command Failed" });
        } else {
            this.log.error("The handler rejected the promise via some means other than " +
                "throwing an Error/ImperativeError or rejecting the promise with a string/nothing.");
            response.console.errorHeader(unexpectedCommandError.message);
            response.console.error("The command indicated failure through an unexpected means.");
            response.console.error(`Contact the creator of handler:`);
            response.console.error(`"${handlerPath}"`);
            response.data.setObj(handlerErr);
        }
    }
}
