
import { createBaseModel } from './baseModel.js';
import bcrypt from 'bcryptjs';
import { SALT_ROUNDS } from '../config/constants.js';

export const createUserModel = () => {
    const baseModel = createBaseModel('users');

    const findByUsername = async (username) => {
        return baseModel.findByCondition({ username });
    };

    const createUser = async (userData) => {
        console.log(userData)
        const hashedPassword = await bcrypt.hash(userData.password_hash, SALT_ROUNDS);
        return baseModel.create({
            ...userData,
            password_hash: hashedPassword,
        });
    };

    const validatePassword = async (hashedPassword, password) => {
        return bcrypt.compare(password, hashedPassword);
    };

    return {
        ...baseModel,
        findByUsername,
        createUser,
        validatePassword
    };
};